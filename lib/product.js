const { getDB, saveDB } = require("./db");

const userState = {};

function getState(senderJid) {
    if (!userState[senderJid]) {
        userState[senderJid] = { step: null, productKey: null, variantName: null };
    }
    return userState[senderJid];
}

function clearState(senderJid) {
    userState[senderJid] = { step: null, productKey: null, variantName: null };
}

function findProduct(query) {
    const db = getDB();
    const q = query.toLowerCase().trim();

    let product = db.products.find(p => p.name === q || p.display.toLowerCase() === q);
    if (product) return product;

    return db.products.find(p => p.name.includes(q) || p.display.toLowerCase().includes(q));
}

function findVariant(product, query) {
    if (!product) return null;
    const q = query.toLowerCase().trim();

    let exactMatch = product.variants.find(v => v.name.toLowerCase() === q);
    if (exactMatch) return exactMatch;

    let partialMatch = product.variants.find(v => v.name.toLowerCase().includes(q));
    if (partialMatch) return partialMatch;

    if (q.includes(" ")) {
        const words = q.split(" ");
        return product.variants.find(v => words.every(w => v.name.toLowerCase().includes(w)));
    }

    return partialMatch;
}

function getVariant(product, variantId) {
    return product.variants.find(v => String(v.id) === String(variantId));
}

function formatProductCard(product) {
    let text = `*Hallo Kak* �\n`;
    text += `*Terima kasih sudah menghubungi* _AzuraStore_🤍\n`;
    text += `──────────────────\n\n`;
    text += `✨ PRICE LIST ${product.display.toUpperCase()} ✨\n`;
    text += `──────────────────\n\n`;
    
    // Group variants by categories if they exist, or just list them
    const groups = {};
    product.variants.forEach(v => {
        const cat = v.category || "GENERAL";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(v);
    });

    for (const [catName, variants] of Object.entries(groups)) {
        if (catName !== "GENERAL") text += `# *${catName.toUpperCase()}*\n`;
        variants.forEach(v => {
            const priceStr = v.price === 0 ? "SEIKHLASNYA" : `${(v.price / 1000).toString().replace('.', ',')}k`;
            text += `✧ ${v.name} : ${priceStr}\n`;
        });
        text += `\n`;
    }

    text += `_Ketik nama varian untuk order_`;
    return text;
}

function formatMenu(db, pushName = "Customer") {
    if (db.products.length === 0) return "📭 Belum ada produk tersedia.";

    const now = new Date();
    const dateStr = now.toLocaleDateString("id-ID");
    const timeStr = now.toLocaleTimeString("id-ID", { hour: '2-digit', minute: '2-digit' });

    let text = `┌──❑  SELAMAT DATANG *@${pushName}*  ❑──┐\n`;
    text += `Grup: Azura Store | Digital Shop\n`;
    text += `Tanggal: ${dateStr} | Jam: ${timeStr} WIB\n\n`;

    text += `✦ List Menu ✦\n`;
    
    // Sort products alphabetically
    const sortedProducts = [...db.products].sort((a, b) => a.display.localeCompare(b.display));
    
    sortedProducts.forEach(p => {
        text += `✧ ${p.display.toUpperCase()}\n`;
    });

    text += `\n_Ketik nama produk untuk melihat varian._`;
    return text;
}

module.exports = {
    userState,
    getState,
    clearState,
    findProduct,
    findVariant,
    getVariant,
    formatProductCard,
    formatMenu
};