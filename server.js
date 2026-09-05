require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true }));

const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype))
});

app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/admin", express.static(path.join(__dirname, "..", "admin")));

function signAdmin(id, email) {
  return jwt.sign({ sub: id, email, role: "admin" }, JWT_SECRET, { expiresIn: "8h" });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
function orderNumber() {
  return "AS" + Date.now().toString().slice(-8) + Math.floor(10 + Math.random() * 90);
}
function cleanProduct(row) {
  return {
    id: Number(row.id),
    name: row.name,
    price: Number(row.price),
    oldPrice: Number(row.old_price),
    category: row.category,
    description: row.description,
    sizes: row.sizes || [],
    image: row.image_url,
    active: row.active,
    stock: row.stock
  };
}

async function seed() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const exists = await pool.query("SELECT id FROM admins WHERE email=$1", [adminEmail]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [adminEmail, hash]);
      console.log("Admin account created:", adminEmail);
    }
  }
  const count = await pool.query("SELECT COUNT(*)::int AS c FROM products");
  if (count.rows[0].c === 0) {
    const seedProducts = [
      ["Stylish Shirt Combo — Watch, Wallet, Perfume, Sunglasses & Belt",1200,1300,"Men Clothing","Full sleeve combo set. Add your own photos from Admin.","[\"M\",\"L\",\"XL\",\"XXL\"]",10],
      ["Premium Shirt Combo — Accessories Gift Set",1200,1300,"Men Clothing","Premium boxed combo set.","[\"M\",\"L\",\"XL\",\"XXL\"]",10],
      ["Boy's Ethnic Panjabi — Festive Combo Set",950,1050,"Boy's Ethnic Clothings","Festive panjabi combo set.","[\"S\",\"M\",\"L\"]",10]
    ];
    for (const p of seedProducts) {
      await pool.query(
        "INSERT INTO products(name,price,old_price,category,description,sizes,stock) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
        p
      );
    }
  }
}

app.get("/api/health", async (_, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

app.get("/api/products", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const values = [];
  let sql = "SELECT * FROM products WHERE active=true";
  if (q) {
    values.push(`%${q}%`);
    sql += ` AND (name ILIKE $${values.length} OR category ILIKE $${values.length})`;
  }
  sql += " ORDER BY created_at DESC";
  const result = await pool.query(sql, values);
  res.json(result.rows.map(cleanProduct));
});

app.get("/api/products/:id", async (req, res) => {
  const result = await pool.query("SELECT * FROM products WHERE id=$1", [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "Product not found" });
  res.json(cleanProduct(result.rows[0]));
});

app.post("/api/orders", async (req, res) => {
  const { customer, items, paymentMethod = "COD" } = req.body;
  if (!customer?.name || !customer?.phone || !customer?.address || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Name, phone, address and at least one item are required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let subtotal = 0;
    const lockedItems = [];

    for (const item of items) {
      const result = await client.query(
        "SELECT * FROM products WHERE id=$1 AND active=true FOR UPDATE", [item.productId]
      );
      if (!result.rowCount) throw new Error("A product is unavailable.");
      const p = result.rows[0];
      const qty = Math.max(1, Math.min(20, Number(item.quantity) || 1));
      if (p.stock < qty) throw new Error(`${p.name} is out of stock.`);
      const unit = Number(p.price);
      subtotal += unit * qty;
      lockedItems.push({ p, qty, size: String(item.size || "") });
    }

    const deliveryFee = Number(customer.deliveryFee || 0);
    const total = subtotal + deliveryFee;
    const number = orderNumber();

    const order = await client.query(
      `INSERT INTO orders(order_number,customer_name,phone,address,district,area,note,payment_method,subtotal,delivery_fee,total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,order_number`,
      [number, customer.name.trim(), customer.phone.trim(), customer.address.trim(),
       customer.district || "", customer.area || "", customer.note || "", paymentMethod,
       subtotal, deliveryFee, total]
    );

    for (const x of lockedItems) {
      await client.query(
        `INSERT INTO order_items(order_id,product_id,product_name,size,quantity,unit_price,line_total)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [order.rows[0].id, x.p.id, x.p.name, x.size, x.qty, Number(x.p.price), Number(x.p.price) * x.qty]
      );
      await client.query("UPDATE products SET stock=stock-$1, updated_at=NOW() WHERE id=$2", [x.qty, x.p.id]);
    }

    await client.query("COMMIT");
    notifyTelegram(order.rows[0].order_number, customer, lockedItems, subtotal, deliveryFee, total).catch(console.error);
    res.status(201).json({ ok: true, orderNumber: order.rows[0].order_number, total });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Order failed" });
  } finally {
    client.release();
  }
});

async function notifyTelegram(number, customer, items, subtotal, delivery, total) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const lines = [
    `🛍️ NEW ORDER — ${number}`,
    `👤 ${customer.name}`,
    `📞 ${customer.phone}`,
    `📍 ${customer.address}`,
    customer.district ? `District: ${customer.district}` : "",
    "",
    ...items.map(x => `• ${x.p.name} | ${x.size || "No size"} | Qty ${x.qty} × ৳${x.p.price}`),
    "",
    `Subtotal: ৳${subtotal}`,
    `Delivery: ৳${delivery}`,
    `TOTAL: ৳${total}`,
    `Payment: ${customer.paymentMethod || "COD"}`
  ].filter(Boolean).join("\n");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines })
  });
}


// Server-side Meta Conversions API. Configure META_PIXEL_ID + META_ACCESS_TOKEN in .env.
// The browser can still use Pixel; this endpoint prevents purchase tracking from depending
// only on the customer's browser.
app.post("/api/meta/event", async (req, res) => {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return res.json({ ok: false, skipped: true });
  const { eventName, eventId, userData = {}, customData = {} } = req.body || {};
  if (!eventName || !eventId) return res.status(400).json({ error: "eventName and eventId required" });
  try {
    const payload = {
      data: [{
        event_name: String(eventName),
        event_time: Math.floor(Date.now()/1000),
        event_id: String(eventId),
        action_source: "website",
        user_data: userData,
        custom_data: customData
      }]
    };
    const url = `https://graph.facebook.com/v23.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
    const r = await fetch(url, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error:"Meta API error", details:data });
    res.json({ ok:true, data });
  } catch (e) {
    res.status(502).json({ error:"Meta event failed" });
  }
});

app.post("/api/admin/login", rateLimit({ windowMs: 10*60_000, limit: 10 }), async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM admins WHERE email=$1", [email]);
  if (!result.rowCount || !(await bcrypt.compare(password || "", result.rows[0].password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.cookie("admin_token", signAdmin(result.rows[0].id, result.rows[0].email), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 8*60*60*1000
  });
  res.json({ ok: true });
});

app.post("/api/admin/logout", auth, (_, res) => {
  res.clearCookie("admin_token");
  res.json({ ok: true });
});

app.get("/api/admin/me", auth, (req, res) => res.json({ email: req.admin.email }));


app.get("/api/orders/track/:orderNumber", async (req, res) => {
  const r = await pool.query(`
    SELECT o.order_number,o.status,o.payment_status,o.total,o.delivery_fee,o.created_at,o.updated_at,
           o.customer_name,o.district,o.area,
           COALESCE(json_agg(json_build_object('productName',i.product_name,'size',i.size,'quantity',i.quantity,'unitPrice',i.unit_price))
           FILTER (WHERE i.id IS NOT NULL),'[]') items
    FROM orders o LEFT JOIN order_items i ON i.order_id=o.id
    WHERE o.order_number=$1 GROUP BY o.id
  `,[String(req.params.orderNumber).trim()]);
  if (!r.rowCount) return res.status(404).json({error:"Order not found"});
  // Do not expose phone/address publicly.
  res.json(r.rows[0]);
});

app.get("/api/admin/stats", auth, async (_,res)=>{
  const r=await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM products WHERE active=true) products,
      (SELECT COUNT(*)::int FROM orders) orders,
      (SELECT COUNT(*)::int FROM orders WHERE status='PENDING') pending,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE status='DELIVERED') revenue
  `);
  res.json(r.rows[0]);
});

app.get("/api/admin/products", auth, async (_, res) => {
  const r = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
  res.json(r.rows.map(cleanProduct));
});

app.post("/api/admin/products", auth, async (req, res) => {
  const p = req.body;
  const r = await pool.query(
    `INSERT INTO products(name,price,old_price,category,description,sizes,image_url,active,stock)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
    [p.name, Number(p.price), Number(p.oldPrice||0), p.category||"", p.description||"",
     JSON.stringify(Array.isArray(p.sizes)?p.sizes:[]), p.image||"", p.active !== false, Number(p.stock||0)]
  );
  res.status(201).json(cleanProduct(r.rows[0]));
});

app.put("/api/admin/products/:id", auth, async (req, res) => {
  const p = req.body;
  const r = await pool.query(
    `UPDATE products SET name=$1,price=$2,old_price=$3,category=$4,description=$5,sizes=$6::jsonb,
     image_url=$7,active=$8,stock=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
    [p.name, Number(p.price), Number(p.oldPrice||0), p.category||"", p.description||"",
     JSON.stringify(Array.isArray(p.sizes)?p.sizes:[]), p.image||"", p.active !== false, Number(p.stock||0), req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({error:"Product not found"});
  res.json(cleanProduct(r.rows[0]));
});

app.delete("/api/admin/products/:id", auth, async (req, res) => {
  await pool.query("UPDATE products SET active=false,updated_at=NOW() WHERE id=$1", [req.params.id]);
  res.json({ok:true});
});

app.post("/api/admin/upload", auth, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({error:"Image required"});
  res.json({url:`/uploads/${req.file.filename}`});
});

app.get("/api/admin/orders", auth, async (_, res) => {
  const r = await pool.query(`
    SELECT o.*,
      COALESCE(json_agg(json_build_object(
        'productName',i.product_name,'size',i.size,'quantity',i.quantity,
        'unitPrice',i.unit_price,'lineTotal',i.line_total
      ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
    FROM orders o LEFT JOIN order_items i ON i.order_id=o.id
    GROUP BY o.id ORDER BY o.created_at DESC
  `);
  res.json(r.rows);
});

app.patch("/api/admin/orders/:id/status", auth, async (req, res) => {
  const allowed = ["PENDING","CONFIRMED","PROCESSING","SHIPPED","DELIVERED","CANCELLED","RETURNED"];
  const status = String(req.body.status || "").toUpperCase();
  if (!allowed.includes(status)) return res.status(400).json({error:"Invalid status"});
  const r = await pool.query("UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *", [status, req.params.id]);
  if (!r.rowCount) return res.status(404).json({error:"Order not found"});
  res.json(r.rows[0]);
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({error:"Not found"});
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

(async () => {
  await pool.query("SELECT 1");
  await seed();
  app.listen(PORT, () => console.log(`AMAR SHOP running on http://localhost:${PORT}`));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
