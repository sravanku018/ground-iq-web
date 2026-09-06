/** Slug a survey question label into a Field ID (unique key). */
export function slugQuestionKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

/** Persist Telugu copy only when the author filled it. */
export function teluguFields(q) {
  const label_te = String(q?.label_te || '').trim()
  const fromArr = Array.isArray(q?.options_te)
    ? q.options_te.map((s) => String(s || '').trim())
    : []
  const fromText = String(q?.options_te_text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const options_te = fromArr.some(Boolean) ? fromArr : fromText
  const extra = {}
  if (label_te) extra.label_te = label_te
  if (options_te.length) extra.options_te = options_te
  return extra
}

/** Telugu add / type / auto-translate — Super Admin grant only. */
export function canTeluguQuestions(user) {
  return user?.role === 'super_admin' || !!user?.can_translate_telugu
}

/** Question text stays exactly as typed. Question ID is never rewritten on label edits. */
export function labelPatch(q, label) {
  const next = String(label || '')
  const patch = { label: next }
  if (!q?.speak || q.speak === q.label) patch.speak = next
  return patch
}

export function nextQuestionId(label, existingId, used) {
  const set = used || new Set()
  let id = String(existingId || '').trim()
  const slug = slugQuestionKey(label)
  if (!id || id.startsWith('q_') || id.length <= 2) {
    if (slug) id = slug
  }
  if (!id) id = slug || `q_${Date.now().toString(36)}`
  const base = id
  let n = 2
  while (set.has(id)) id = `${base}_${n++}`
  set.add(id)
  return id
}

export function isQuestionVisible(q) {
  return q?.visible !== false
}

/**
 * Known legacy/transient question keys mapped to current canonical question slugs.
 * Used for backwards-compatibility when rendering or editing older survey submissions.
 */
export const LEGACY_QUESTION_ALIASES = {
  which_you_prefer_to_watch: ['id', 'w', 'which_you_prefer_to_watch'],
  are_you_eligible_for_any_present_state_govt_schemes: [
    '2_whats_on',
    'q_mtpkyf2o',
    'whats_on',
    '2_whats_on_gen',
    'are_you_eligible_for_any_present_state_govt_schemes',
  ],
}

/** Get all potential keys/aliases for a question (canonical ID, slug, legacy aliases). */
export function getQuestionAliases(q) {
  const aliases = new Set()
  if (!q) return []
  const id = String(q.id || '').trim()
  const labelSlug = q.label ? slugQuestionKey(q.label) : ''
  const key = String(q.key || '').trim()
  if (id) {
    aliases.add(id)
    aliases.add(id.toLowerCase())
  }
  if (labelSlug) {
    aliases.add(labelSlug)
  }
  if (key) {
    aliases.add(key)
    aliases.add(key.toLowerCase())
  }

  const checkKeys = [id, labelSlug, key].filter(Boolean)
  for (const k of checkKeys) {
    const kNorm = k.toLowerCase()
    const legacy = LEGACY_QUESTION_ALIASES[kNorm]
    if (Array.isArray(legacy)) {
      for (const al of legacy) {
        aliases.add(al)
        aliases.add(al.toLowerCase())
      }
    }
  }
  return [...aliases]
}

/**
 * Safely resolves an answer value for a question from an answers map, checking canonical keys,
 * label slug, and any known legacy aliases.
 */
export function resolveAnswerValue(answers, q) {
  if (!answers || typeof answers !== 'object' || !q) return ''
  const id = String(q.id || slugQuestionKey(q.label) || '').trim()
  if (answers[id] !== undefined && answers[id] !== null && answers[id] !== '') {
    return answers[id]
  }
  if (q.id && answers[q.id] !== undefined && answers[q.id] !== null && answers[q.id] !== '') {
    return answers[q.id]
  }
  if (q.label) {
    const slug = slugQuestionKey(q.label)
    if (answers[slug] !== undefined && answers[slug] !== null && answers[slug] !== '') {
      return answers[slug]
    }
  }
  const aliases = getQuestionAliases(q)
  for (const al of aliases) {
    if (answers[al] !== undefined && answers[al] !== null && answers[al] !== '') {
      return answers[al]
    }
  }
  return ''
}

