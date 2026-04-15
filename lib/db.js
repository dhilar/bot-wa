const fs = require("fs")

function ensureDB(dbFile) {
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(
      dbFile,
      JSON.stringify(
        {
          orders: [],
          list: [],
          users: {},
          groups: {},
          settings: {
            antiLinkGlobal: false,
            multiPrefix: false,
            prefixes: ["-", "!", "/"]
          }
        },
        null,
        2
      )
    )
  }
}

function loadDB(dbFile) {
  ensureDB(dbFile)
  const data = JSON.parse(fs.readFileSync(dbFile, "utf8"))

  // Ensure all keys exist
  if (!data.orders) data.orders = []
  if (!data.list) data.list = []
  if (!data.users) data.users = {}
  if (!data.groups) data.groups = {}
  if (!data.settings) {
    data.settings = {
      antiLinkGlobal: false,
      multiPrefix: false,
      prefixes: ["-", "!", "/"]
    }
  }

  return data
}

function saveDB(dbFile, data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2))
}

module.exports = {
  ensureDB,
  loadDB,
  saveDB
}