import type { Ctx } from "./ctx.ts";
import {
  randomBytes,
} from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@14.0.3";
import {
  logAudit,
} from "../lib/audit.ts";
import {
  b64ToBytes,
  sha256Hex,
} from "../lib/bytes.ts";
import {
  hashPasswordAsync,
  newToken,
  verifyPassword,
} from "../lib/crypto.ts";
import {
  sql,
} from "../lib/db.ts";
import {
  json,
  readBody,
} from "../lib/http.ts";
import {
  checkRateLimit,
  clientIp,
} from "../lib/rate-limit.ts";
import {
  sqlBool,
  sqlCountN,
} from "../lib/users.ts";
import {
  authUserPayload,
  bytesToBase64Url,
  createWebAuthnFlow,
  takeWebAuthnFlow,
  webauthnOrigin,
  webauthnRpId,
  webauthnTransports,
} from "../lib/webauthn.ts";

export async function handleAuth(c: Ctx): Promise<Response | null> {
  const { req, url, path, method, me } = c;

  // Public login-method discovery: the sign-in screen asks which quick-login
  // options exist for a username BEFORE the user signs in. Unknown usernames
  // get the same shape as an account with nothing enabled (no enumeration).
  if (path === "/api/auth/methods" && method === "GET") {
    const ip = clientIp(req);
    if (!checkRateLimit(`methods:${ip}`, 30)) {
      return json({ error: "Too many requests. Try again later." }, 429);
    }
    const username = String(url.searchParams.get("username") || "").trim().toLowerCase();
    if (!username || username.length > 100) {
      return json({ has_pin: false, has_passkey: false, has_device: false });
    }
    const rows = await sql`
        SELECT u.id,
               (u.pin_hash IS NOT NULL) AS has_pin,
               EXISTS(SELECT 1 FROM webauthn_credentials p WHERE p.user_id = u.id) AS has_passkey,
               EXISTS(
                 SELECT 1 FROM app_device_tokens d
                 WHERE d.user_id = u.id AND d.expires_at > NOW()
               ) AS has_device
        FROM app_users u
        WHERE LOWER(u.username) = ${username}
          AND u.role IN ('super_admin', 'admin', 'sub_client_admin', 'surveyor')
          AND u.active = TRUE
        LIMIT 1
      `.catch(() => []);
    const row = rows[0] as Record<string, unknown> | undefined;
    return json({
      has_pin: !!row?.has_pin,
      has_passkey: !!row?.has_passkey,
      has_device: !!row?.has_device,
    });
  }

  // ── Native Android fingerprint unlock (BiometricPrompt) ──
  // The device stores a long-lived token, encrypted with AndroidKeyStore.
  // This is not WebAuthn/passkeys; it exchanges the token for a session.
  if (path === "/api/auth/device-token" && method === "POST") {
    if (!me) return json({ error: "Login required" }, 401);
    if (me.role === "super_admin") {
      return json({ error: "Fingerprint unlock is for field and client-admin accounts." }, 403);
    }
    const deviceToken = `dev_${randomBytes(32).toString("base64url")}`;
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    await sql`
        INSERT INTO app_device_tokens (user_id, token_hash, label, expires_at)
        VALUES (${me.id}, ${await sha256Hex(deviceToken)}, ${"Android fingerprint"}, ${expires.toISOString()})
      `;
    await sql`DELETE FROM app_device_tokens WHERE expires_at < NOW()`.catch(() => null);
    logAudit(me, "device_token_create", "user", me.id, {});
    return json({ device_token: deviceToken, expires_at: expires.toISOString() });
  }

  if (path === "/api/auth/device-login" && method === "POST") {
    const ip = clientIp(req);
    if (!checkRateLimit(`auth:${ip}`)) {
      return json({ error: "Too many login attempts. Try again later." }, 429);
    }
    const body = await readBody(req);
    const deviceToken = String(body.device_token || "").trim();
    if (!deviceToken) return json({ error: "device_token is required" }, 400);
    const rows = await sql`
        SELECT * FROM app_device_tokens
        WHERE token_hash = ${await sha256Hex(deviceToken)} AND expires_at > NOW()
        LIMIT 1
      `.catch(() => []);
    if (!rows.length) {
      return json({
        error: "Fingerprint unlock expired. Sign in with your password.",
      }, 401);
    }
    const deviceRow = rows[0] as Record<string, unknown>;
    const userRows = await sql`
        SELECT * FROM app_users WHERE id = ${Number(deviceRow.user_id)} LIMIT 1
      `.catch(() => []);
    const user = userRows[0] as Record<string, unknown> | undefined;
    if (!user || !sqlBool(user.active)) {
      return json({ error: "Account is disabled." }, 403);
    }
    if (user.role === "super_admin") {
      return json({ error: "Fingerprint unlock is for field and client-admin accounts." }, 403);
    }
    const expectedRole = String(body.expected_role || "").trim().toLowerCase();
    if (expectedRole === "surveyor" && user.role !== "surveyor") {
      return json({ error: "This fingerprint is not a surveyor login." }, 403);
    }
    if (expectedRole === "admin" && user.role !== "admin") {
      return json({ error: "Client Admin portal only." }, 403);
    }
    const sessionToken = newToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`
        INSERT INTO app_sessions (token, user_id, expires_at)
        VALUES (${sessionToken}, ${Number(user.id)}, ${expires.toISOString()})
      `;
    await sql`
        UPDATE app_device_tokens SET last_used_at = NOW() WHERE id = ${Number(deviceRow.id)}
      `.catch(() => null);
    logAudit(
      {
        id: Number(user.id),
        username: String(user.username || ""),
        role: String(user.role || ""),
      },
      "login_device_fingerprint",
      "user",
      Number(user.id),
      { expected_role: expectedRole || null },
    );
    return json({
      token: sessionToken,
      user: authUserPayload(user),
      expires_at: expires.toISOString(),
      access:
        user.role === "surveyor"
          ? "surveyor_field_app"
          : "client_admin_portal",
      note: "Signed in with Android fingerprint unlock",
    });
  }

  if (path === "/api/auth/device-token" && method === "DELETE") {
    const body = await readBody(req);
    const deviceToken = String(body.device_token || "").trim();
    if (!deviceToken) return json({ error: "device_token is required" }, 400);
    await sql`
        DELETE FROM app_device_tokens WHERE token_hash = ${await sha256Hex(deviceToken)}
      `.catch(() => null);
    return json({ ok: true });
  }

  // ── 4-digit PIN quick-login (opt-in per account; super_admin excluded) ──
  // The PIN is a convenience unlock for people who set one. Guessing is gated
  // by a per-user lockout (5 wrong → 15 min) on top of the per-IP limiter.
  if (path === "/api/auth/pin/setup" && method === "POST") {
    if (!me) return json({ error: "Login required" }, 401);
    if (me.role === "super_admin") {
      return json({ error: "Super Admin uses password + authenticator sign-in." }, 403);
    }
    const body = await readBody(req);
    const pin = String(body.pin || "").trim();
    if (!/^\d{4}$/.test(pin)) return json({ error: "PIN must be exactly 4 digits." }, 400);
    const pinHash = await hashPasswordAsync(pin);
    await sql`
        UPDATE app_users
        SET pin_hash = ${pinHash}, pin_failed_attempts = 0, pin_locked_until = NULL
        WHERE id = ${Number(me.id)}
      `;
    logAudit(me, "pin_setup", "user", Number(me.id), {});
    return json({ ok: true, has_pin: true });
  }

  if (path === "/api/auth/pin/disable" && method === "POST") {
    if (!me) return json({ error: "Login required" }, 401);
    if (me.role === "super_admin") {
      return json({ error: "Super Admin uses password + authenticator sign-in." }, 403);
    }
    await sql`
        UPDATE app_users SET pin_hash = NULL, pin_failed_attempts = 0, pin_locked_until = NULL
        WHERE id = ${Number(me.id)}
      `;
    logAudit(me, "pin_disable", "user", Number(me.id), {});
    return json({ ok: true, has_pin: false });
  }

  if (path === "/api/auth/pin/login" && method === "POST") {
    const ip = clientIp(req);
    if (!checkRateLimit(`auth:${ip}`)) {
      return json({ error: "Too many login attempts. Try again later." }, 429);
    }
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const pin = String(body.pin || "").trim();
    if (!username || !/^\d{4}$/.test(pin)) {
      return json({ error: "Username and 4-digit PIN are required." }, 400);
    }
    const userRows = await sql`
        SELECT * FROM app_users WHERE LOWER(username) = ${username} LIMIT 1
      `.catch(() => []);
    const user = userRows[0] as Record<string, unknown> | undefined;
    if (!user || !sqlBool(user.active)) {
      return json({ error: "Invalid username or PIN." }, 401);
    }
    if (user.role === "super_admin") {
      return json({ error: "Super Admin uses password + authenticator sign-in." }, 403);
    }
    if (user.role !== "admin" && user.role !== "sub_client_admin" && user.role !== "surveyor") {
      return json({ error: "Account not allowed." }, 403);
    }
    if (!user.pin_hash) {
      return json({ error: "No PIN set for this account — sign in with your password." }, 401);
    }
    // Lockout: 5 consecutive wrong PINs -> 15-minute lock. Password login is unaffected.
    if (user.pin_locked_until && new Date(String(user.pin_locked_until)).getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((new Date(String(user.pin_locked_until)).getTime() - Date.now()) / 60000));
      return json({ error: `PIN locked after too many wrong attempts — try again in ${mins} minute(s), or sign in with your password.` }, 423);
    }
    const ok = await verifyPassword(pin, String(user.pin_hash || ""));
    if (!ok) {
      const attempts = Number(user.pin_failed_attempts || 0) + 1;
      if (attempts >= 5) {
        await sql`
            UPDATE app_users SET pin_failed_attempts = ${attempts}, pin_locked_until = NOW() + INTERVAL '15 minutes'
            WHERE id = ${Number(user.id)}
          `;
        return json({ error: "Wrong PIN — 5 attempts made. PIN locked for 15 minutes; sign in with your password." }, 423);
      }
      await sql`UPDATE app_users SET pin_failed_attempts = ${attempts} WHERE id = ${Number(user.id)}`;
      return json({ error: `Wrong PIN. ${5 - attempts} attempt(s) left before the PIN locks.`, attempts_left: 5 - attempts }, 401);
    }
    await sql`
        UPDATE app_users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ${Number(user.id)}
      `;
    const expectedRole = String(body.expected_role || "").trim().toLowerCase();
    if (expectedRole === "surveyor" && user.role !== "surveyor") {
      return json({ error: "This PIN is not a surveyor login." }, 403);
    }
    if (expectedRole === "admin" && user.role !== "admin" && user.role !== "sub_client_admin") {
      return json({ error: "Client Admin portal only." }, 403);
    }
    const sessionToken = newToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`
        INSERT INTO app_sessions (token, user_id, expires_at)
        VALUES (${sessionToken}, ${Number(user.id)}, ${expires.toISOString()})
      `;
    logAudit(
      {
        id: Number(user.id),
        username: String(user.username || ""),
        role: String(user.role || ""),
      },
      "login_pin",
      "user",
      Number(user.id),
      { expected_role: expectedRole || null },
    );
    return json({
      token: sessionToken,
      user: authUserPayload(user),
      expires_at: expires.toISOString(),
      access:
        user.role === "surveyor"
          ? "surveyor_field_app"
          : "client_admin_portal",
      note: "Signed in with 4-digit PIN",
    });
  }

  // ── Fingerprint / passkey login (WebAuthn) ─────────────
  if (path === "/api/auth/webauthn/register/options" && method === "POST") {
    if (!me) return json({ error: "Login required" }, 401);
    if (me.role === "super_admin") {
      return json({ error: "Super Admin uses password + authenticator sign-in." }, 403);
    }
    const body = await readBody(req);
    let origin: string;
    try {
      origin = webauthnOrigin(body.origin);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    const rpID = webauthnRpId(origin);
    const existing = await sql`
        SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ${me.id}
      `.catch(() => []);
    try {
      const options = await generateRegistrationOptions({
        rpName: "Smart Survey X",
        rpID,
        userID: new TextEncoder().encode(String(me.id)),
        userName: String(me.username || ""),
        userDisplayName: String(me.name || me.username || ""),
        attestationType: "none",
        excludeCredentials: (existing as Record<string, unknown>[]).map((c) => ({
          id: String(c.credential_id),
          transports: webauthnTransports(c.transports),
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
          authenticatorAttachment: "platform",
        },
      });
      const flow_id = await createWebAuthnFlow({
        userId: Number(me.id),
        kind: "registration",
        challenge: options.challenge,
        origin,
        rpId: rpID,
      });
      return json({ options, flow_id });
    } catch (e) {
      return json({
        error: (e as Error).message || "Could not start fingerprint setup",
      }, 400);
    }
  }

  if (path === "/api/auth/webauthn/register/verify" && method === "POST") {
    if (!me) return json({ error: "Login required" }, 401);
    if (me.role === "super_admin") {
      return json({ error: "Super Admin uses password + authenticator sign-in." }, 403);
    }
    const body = await readBody(req);
    let origin: string;
    try {
      origin = webauthnOrigin(body.origin);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    const flow = await takeWebAuthnFlow(
      String(body.flow_id || ""),
      "registration",
    );
    if (
      !flow ||
      Number(flow.user_id) !== Number(me.id) ||
      String(flow.origin) !== origin
    ) {
      return json({ error: "Fingerprint setup expired — start again." }, 400);
    }
    try {
      const result = await verifyRegistrationResponse({
        response: body.response as never,
        expectedChallenge: String(flow.challenge),
        expectedOrigin: origin,
        expectedRPID: String(flow.rp_id),
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) {
        return json({ error: "Fingerprint could not be verified." }, 400);
      }
      const info = result.registrationInfo;
      const cred = info.credential;
      await sql`
          INSERT INTO webauthn_credentials (
            user_id, credential_id, public_key, counter, transports,
            device_type, backed_up
          ) VALUES (
            ${me.id}, ${cred.id}, ${bytesToBase64Url(cred.publicKey)},
            ${cred.counter || 0}, ${JSON.stringify(cred.transports || [])},
            ${info.credentialDeviceType}, ${info.credentialBackedUp}
          )
          ON CONFLICT (credential_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            public_key = EXCLUDED.public_key,
            counter = EXCLUDED.counter,
            transports = EXCLUDED.transports,
            device_type = EXCLUDED.device_type,
            backed_up = EXCLUDED.backed_up
        `;
      const countRows = await sql`
          SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = ${me.id}
        `.catch(() => []);
      logAudit(me, "webauthn_register", "user", me.id, {});
      return json({
        ok: true,
        enabled: true,
        count: sqlCountN(countRows[0]),
      });
    } catch (e) {
      return json({
        error: (e as Error).message || "Fingerprint setup failed.",
      }, 400);
    }
  }

  if (path === "/api/auth/webauthn/login/options" && method === "POST") {
    const ip = clientIp(req);
    if (!checkRateLimit(`auth:${ip}`)) {
      return json({ error: "Too many login attempts. Try again later." }, 429);
    }
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    let origin: string;
    try {
      origin = webauthnOrigin(body.origin);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    const rpID = webauthnRpId(origin);
    // With a username we filter to that user's credentials. Without one, the
    // browser shows the device's discoverable passkeys (one-tap sign-in).
    let userId: number | null = null;
    let credRows: Record<string, unknown>[] = [];
    if (username) {
      const userRows = await sql`
          SELECT id, role, active FROM app_users WHERE LOWER(username) = ${username} LIMIT 1
        `.catch(() => []);
      const user = userRows[0] as
        | { id?: number; role?: string; active?: boolean }
        | undefined;
      userId =
        user && user.active && user.role !== "super_admin"
          ? Number(user.id)
          : null;
      credRows = userId
        ? (await sql`
              SELECT credential_id, transports
              FROM webauthn_credentials WHERE user_id = ${userId}
            `.catch(() => [])) as Record<string, unknown>[]
        : [];
    }
    try {
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: (credRows as Record<string, unknown>[]).map((c) => ({
          id: String(c.credential_id),
          transports: webauthnTransports(c.transports),
        })),
        userVerification: "required",
      });
      const flow_id = await createWebAuthnFlow({
        userId,
        kind: "authentication",
        challenge: options.challenge,
        origin,
        rpId: rpID,
      });
      return json({ options, flow_id });
    } catch (e) {
      return json({
        error: (e as Error).message || "Could not start fingerprint sign-in",
      }, 400);
    }
  }

  if (path === "/api/auth/webauthn/login/verify" && method === "POST") {
    const ip = clientIp(req);
    if (!checkRateLimit(`auth:${ip}`)) {
      return json({ error: "Too many login attempts. Try again later." }, 429);
    }
    const body = await readBody(req);
    let origin: string;
    try {
      origin = webauthnOrigin(body.origin);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    const flow = await takeWebAuthnFlow(
      String(body.flow_id || ""),
      "authentication",
    );
    if (!flow || String(flow.origin) !== origin) {
      return json({ error: "Fingerprint sign-in expired — try again." }, 400);
    }
    const response = body.response as Record<string, unknown> | undefined;
    const responseId = String(response?.id || "");
    if (!responseId) {
      return json({ error: "Invalid fingerprint response." }, 400);
    }
    // With a username, the credential must belong to that user. Without one,
    // the credential id identifies the user for a discoverable passkey.
    const flowUserId = flow.user_id != null ? Number(flow.user_id) : null;
    const credRows = flowUserId
      ? await sql`
            SELECT * FROM webauthn_credentials
            WHERE user_id = ${flowUserId} AND credential_id = ${responseId}
            LIMIT 1
          `.catch(() => [])
      : await sql`
            SELECT * FROM webauthn_credentials
            WHERE credential_id = ${responseId}
            LIMIT 1
          `.catch(() => []);
    if (!credRows.length) {
      return json({ error: "Fingerprint sign-in failed." }, 401);
    }
    const credential = credRows[0] as Record<string, unknown>;
    const userId = Number(credential.user_id);
    try {
      const result = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: String(flow.challenge),
        expectedOrigin: origin,
        expectedRPID: String(flow.rp_id),
        credential: {
          id: String(credential.credential_id),
          publicKey: b64ToBytes(String(credential.public_key)),
          counter: Number(credential.counter) || 0,
          transports: webauthnTransports(credential.transports),
        },
        requireUserVerification: true,
      });
      if (!result.verified) {
        return json({ error: "Fingerprint sign-in failed." }, 401);
      }
      await sql`
          UPDATE webauthn_credentials
          SET counter = ${result.authenticationInfo.newCounter}, last_used_at = NOW()
          WHERE id = ${credential.id}
        `.catch(() => null);
      const rows = await sql`
          SELECT * FROM app_users WHERE id = ${userId} LIMIT 1
        `.catch(() => []);
      const user = rows[0] as Record<string, unknown> | undefined;
      if (!user || !sqlBool(user.active)) {
        return json({ error: "Account is disabled." }, 403);
      }
      if (user.role === "super_admin") {
        return json({
          error: "Super Admin uses password + authenticator sign-in.",
        }, 403);
      }
      const expectedRole = String(body.expected_role || "").trim().toLowerCase();
      if (expectedRole === "surveyor" && user.role !== "surveyor") {
        return json({ error: "This fingerprint is not a surveyor login." }, 403);
      }
      if (
        expectedRole === "admin" &&
        user.role !== "admin" &&
        user.role !== "super_admin" &&
        user.role !== "sub_client_admin"
      ) {
        return json({ error: "Client Admin portal only." }, 403);
      }
      const sessionToken = newToken();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await sql`
          INSERT INTO app_sessions (token, user_id, expires_at)
          VALUES (${sessionToken}, ${userId}, ${expires.toISOString()})
        `;
      logAudit(
        {
          id: Number(user.id),
          username: String(user.username || ""),
          role: String(user.role || ""),
        },
        "login_webauthn",
        "user",
        Number(user.id),
        { expected_role: expectedRole || null },
      );
      return json({
        token: sessionToken,
        user: authUserPayload(user),
        expires_at: expires.toISOString(),
        access:
          user.role === "surveyor"
            ? "surveyor_field_app"
            : "client_admin_portal",
        note: "Signed in with fingerprint / passkey",
      });
    } catch (e) {
      return json({
        error: (e as Error).message || "Fingerprint sign-in failed.",
      }, 401);
    }
  }

  if (path === "/api/auth/webauthn/credentials" && method === "GET") {
    if (!me) return json({ error: "Login required" }, 401);
    const rows = await sql`
        SELECT id, created_at, last_used_at, device_type, backed_up
        FROM webauthn_credentials
        WHERE user_id = ${me.id}
        ORDER BY id DESC
      `.catch(() => []);
    return json({ count: rows.length, items: rows });
  }

  if (path === "/api/auth/webauthn/credentials" && method === "DELETE") {
    if (!me) return json({ error: "Login required" }, 401);
    await sql`DELETE FROM webauthn_credentials WHERE user_id = ${me.id}`
      .catch(() => null);
    return json({ ok: true, count: 0 });
  }
  return null;
}
