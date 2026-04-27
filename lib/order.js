const { getDB, saveDB } = require("./db");

function createOrderId() {
    const db = getDB();
    const lastId = db.orders.length > 0 ? parseInt(db.orders[db.orders.length - 1].id.split("-")[1]) : 0;
    return `INV-${lastId + 1}`;
}

function createOrder(userJid, product, variant, qty = 1) {
    const db = getDB();
    const orderId = createOrderId();
    const now = new Date();

    const order = {
        id: orderId,
        user: userJid,
        userName: db.users[userJid]?.name || "User",
        productName: product.display,
        variantName: variant.name,
        price: variant.price,
        qty: qty,
        total: variant.price * qty,
        status: "pending",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60000).toISOString()
    };

    variant.stock -= qty;

    db.orders.push(order);
    saveDB();
    return order;
}

function cancelOrder(orderId, reason = "Manual Cancel") {
    const db = getDB();
    const orderIndex = db.orders.findIndex(o => o.id === orderId);
    if (orderIndex === -1) return null;

    const order = db.orders[orderIndex];
    if (order.status !== "pending") return null;

    const product = db.products.find(p => p.display === order.productName);
    if (product) {
        const variant = product.variants.find(v => v.name === order.variantName);
        if (variant) variant.stock += order.qty;
    }

    order.status = "cancelled";
    order.cancelReason = reason;
    saveDB();
    return order;
}

function completeOrder(orderId) {
    const db = getDB();
    const order = db.orders.find(o => o.id === orderId);
    if (!order || order.status !== "pending") return null;

    order.status = "success";
    saveDB();
    return order;
}

function formatInvoice(order) {
    const db = getDB();
    const statusText = order.status === "pending"
        ? "⚠️ Menunggu Pembayaran"
        : order.status === "success"
        ? "✅ Lunas"
        : "❌ Dibatalkan";

    let text = `🧾 *INVOICE ${order.id}*\n\n`;
    text += `📦 Produk: ${order.productName}\n`;
    text += `✨ Varian: ${order.variantName}\n`;
    text += `🔢 Qty: ${order.qty}\n`;
    text += `💵 Total: Rp ${order.total.toLocaleString("id-ID")}\n`;
    text += `📌 Status: ${statusText}\n`;
    text += `🕒 Tanggal: ${new Date(order.createdAt).toLocaleString("id-ID")}\n\n`;

    if (order.status === "pending") {
        const paymentInfo = db.settings?.paymentInfo || "Silakan hubungi Owner untuk pembayaran.";
        text += `💳 *INFO PEMBAYARAN*\n${paymentInfo}\n\n`;
        text += `_Ketik \"pay\" untuk melihat QRIS (jika tersedia)_`;
    }

    return text.trim();
}

module.exports = {
    createOrder,
    cancelOrder,
    completeOrder,
    formatInvoice
};