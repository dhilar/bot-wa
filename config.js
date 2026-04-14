const path = require("path")

module.exports = {
  prefix: "-",
  debug: true,
  botName: "Digimu Bot",
  ownerNumbers: [
    "6285138745718"
  ], // ganti ke nomor kamu, format angka saja

  sessionPath: path.join(__dirname, "session"),
  dbFile: path.join(__dirname, "db.json"),

  cooldownMs: 2500, 
  cooldownSweepMs: 60 * 1000,

  timezone: "Asia/Jakarta"
}