const fs = require("fs");
const path = require("path");

let db = null;
let dbPath = null;
let saveTimeout = null;

function ensureDB(filePath) {
    dbPath = filePath;
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(
            dbPath,
            JSON.stringify(
                {
                    orders: [],
                    products: [], // New structure
                    users: {},
                    groups: {},
                    payment: { text: "", image: null },
                    explanations: {},
                    settings: {
                        antiLinkGlobal: false,
                        multiPrefix: false,
                        prefixes: ["#"],
                        autoStatus: { enabled: false, text: "", interval: 30, lastSent: 0 }
                    }
                },
                null,
                2
            )
        );
    }
}

function applyDefaults(db) {
    if (!db.orders) db.orders = [];
    if (!db.products) db.products = [];
    if (!db.users) db.users = {};
    if (!db.groups) db.groups = {};
    if (!db.payment) db.payment = { text: "", image: null };
    if (!db.explanations) db.explanations = {};

    if (!db.settings) db.settings = {};
    if (typeof db.settings.antiLinkGlobal !== "boolean") db.settings.antiLinkGlobal = false;
    if (typeof db.settings.multiPrefix !== "boolean") db.settings.multiPrefix = false;
    if (!Array.isArray(db.settings.prefixes)) db.settings.prefixes = ["#"];

    if (!db.settings.autoStatus) {
        db.settings.autoStatus = {
            enabled: false,
            text: "",
            interval: 30,
            lastSent: 0
        };
    }

    return db;
}

function loadDB(filePath) {
    if (db) return db;

    ensureDB(filePath);

    try {
        db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

        if (db.list && !db.products) {
            db.products = db.list.map(item => ({
                name: String(item.nama || "").toLowerCase(),
                display: item.nama,
                category: item.kategori,
                variants: [{
                    id: item.id,
                    name: item.nama,
                    price: item.harga,
                    stock: item.stock,
                    description: item.deskripsi
                }]
            }));
            delete db.list;
        }

        db = applyDefaults(db);
        saveDB();

        return db;
    } catch (e) {
        console.error("Error loading DB:", e);
        db = applyDefaults({});
        return db;
    }
}

/**
 * Debounced save to prevent excessive disk I/O
 */
function saveDB() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        saveTimeout = null;
    }, 5000); // Save every 5 seconds if there are changes
}

module.exports = {
    loadDB,
    saveDB,
    getDB: () => db
};
