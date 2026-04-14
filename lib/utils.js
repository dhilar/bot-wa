function cleanDigits(value = "") {
  return String(value).replace(/\D/g, "")
}

function normalizeJidToNumber(jid = "") {
  const raw = String(jid).split("@")[0]

  if (raw.includes(":")) {
    return cleanDigits(raw.split(":")[0])
  }

  const digits = cleanDigits(raw)

  if (digits.startsWith("0")) {
    return "62" + digits.slice(1)
  }

  return digits
}

function isOwner(senderJid, senderNumber, ownerNumbers = [], ownerJids = []) {
  const cleanSenderJid = String(senderJid || "").toLowerCase()
  const cleanSenderNumber = cleanDigits(senderNumber)

  const jidMatch = ownerJids.some(jid =>
    String(jid).toLowerCase() === cleanSenderJid
  )

  if (jidMatch) return true

  const numberMatch = ownerNumbers.some(num => {
    const cleanOwner = cleanDigits(num)
    return (
      cleanSenderNumber === cleanOwner ||
      cleanSenderNumber.endsWith(cleanOwner.slice(-10))
    )
  })

  return numberMatch
}

module.exports = {
  cleanText,
  parseMessageText,
  normalizeJidToNumber,
  isOwner,
  runtime,
  formatBytes
}