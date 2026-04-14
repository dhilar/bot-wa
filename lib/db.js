const fs = require("fs")

function ensureDB(dbFile) {
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(
      dbFile,
      JSON.stringify(
        {
          orders: [],
          list: []
        },
        null,
        2
      )
    )
  }
}

function loadDB(dbFile) {
  ensureDB(dbFile)
  return JSON.parse(fs.readFileSync(dbFile, "utf8"))
}

function saveDB(dbFile, data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2))
}

module.exports = {
  ensureDB,
  loadDB,
  saveDB
}