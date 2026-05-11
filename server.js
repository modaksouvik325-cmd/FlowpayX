// =====================================================
// FlowPayX - Programmable Payment Workflow MVP
// Backend: Node.js + Express + Razorpay (Test Mode)
// Storage: In-memory array (resets when server restarts)
// =====================================================

const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = 3000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Razorpay Test Keys ----------
// ⚠️ Replace these with YOUR OWN Razorpay TEST keys
// Get them from: https://dashboard.razorpay.com/app/keys
const RAZORPAY_KEY_ID = "rzp_test_SoAB92IEn2mqZ1";
const RAZORPAY_KEY_SECRET = "p69vbgPRwJ0Z2zDgYpmDkxup";

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- In-Memory Storage ----------
// Each payment looks like:
// { id, title, amount, status, createdAt, lockedAt, releasedAt, autoReleaseAt }
let payments = [];
let paymentCounter = 1;

// ---------- Helper: Generate Payment ID ----------
function generatePaymentId() {
  return "FPX-" + String(paymentCounter++).padStart(4, "0");
}

// ---------- Helper: Find Payment ----------
function findPayment(id) {
  return payments.find((p) => p.id === id);
}

// =====================================================
// ROUTE 1: Create a new payment (status = "created")
// =====================================================
app.post("/create-payment", (req, res) => {
  console.log("📝 [CREATE-PAYMENT] body:", req.body);

  const { title, amount, autoReleaseSeconds } = req.body;

  // --- Validation ---
  if (!title || typeof title !== "string") {
    return res.status(400).json({
      success: false,
      message: "Title is required",
    });
  }
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({
      success: false,
      message: "Amount must be a positive number",
    });
  }

  const payment = {
    id: generatePaymentId(),
    title: title.trim(),
    amount: Number(amount),
    status: "created", // initial state
    createdAt: new Date().toISOString(),
    lockedAt: null,
    releasedAt: null,
    autoReleaseAt: null,
    autoReleaseSeconds: autoReleaseSeconds ? Number(autoReleaseSeconds) : null,
    razorpayOrderId: null,
    razorpayPaymentId: null,
  };

  payments.push(payment);
  console.log("✅ Payment created:", payment.id);

  return res.json({
    success: true,
    message: "Payment created successfully",
    payment,
  });
});

// =====================================================
// ROUTE 2: Create a Razorpay order for a payment
// (This is needed before opening Razorpay checkout popup)
// =====================================================
app.post("/create-order", async (req, res) => {
  console.log("🛒 [CREATE-ORDER] body:", req.body);

  const { paymentId } = req.body;
  const payment = findPayment(paymentId);

  if (!payment) {
    return res.status(404).json({
      success: false,
      message: "Payment not found",
    });
  }
  if (payment.status !== "created") {
    return res.status(400).json({
      success: false,
      message: `Cannot create order. Payment is already '${payment.status}'`,
    });
  }

  try {
    // Razorpay needs amount in PAISE (1 INR = 100 paise)
    const order = await razorpay.orders.create({
      amount: Math.round(payment.amount * 100),
      currency: "INR",
      receipt: payment.id,
    });

    payment.razorpayOrderId = order.id;
    console.log("✅ Razorpay order created:", order.id);

    return res.json({
      success: true,
      message: "Order created",
      order,
      keyId: RAZORPAY_KEY_ID,
      payment,
    });
  } catch (err) {
    console.error("❌ Razorpay order error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to create Razorpay order. Check your test API keys.",
    });
  }
});

// =====================================================
// ROUTE 3: Fund a payment (called AFTER successful Razorpay payment)
// Transition: created -> locked
// =====================================================
app.post("/fund-payment/:id", (req, res) => {
  const { id } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  console.log("💰 [FUND-PAYMENT]", id, req.body);

  const payment = findPayment(id);
  if (!payment) {
    return res.status(404).json({
      success: false,
      message: "Payment not found",
    });
  }

  // 🚨 STRICT CHECK: Only "created" payments can be funded
  if (payment.status !== "created") {
    return res.status(400).json({
      success: false,
      message: `Invalid transition. Payment is '${payment.status}', must be 'created'`,
    });
  }

  // --- Verify Razorpay signature (security best practice) ---
  /*
  if (razorpay_payment_id && razorpay_order_id && razorpay_signature) {
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.warn("⚠️ Signature mismatch for payment:", id);
      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed",
      });
    }
    payment.razorpayPaymentId = razorpay_payment_id;
  }
    */

  // --- Transition to "locked" ---
  payment.status = "locked";
  payment.lockedAt = new Date().toISOString();

  // If auto-release was requested, schedule it
  if (payment.autoReleaseSeconds && payment.autoReleaseSeconds > 0) {
    const releaseTime =
      Date.now() + payment.autoReleaseSeconds * 1000;
    payment.autoReleaseAt = new Date(releaseTime).toISOString();

    setTimeout(() => {
      const p = findPayment(id);
      if (p && p.status === "locked") {
        p.status = "released";
        p.releasedAt = new Date().toISOString();
        console.log("⏰ Auto-released payment:", id);
      }
    }, payment.autoReleaseSeconds * 1000);
  }

  console.log("🔒 Payment locked:", id);

  return res.json({
    success: true,
    message: "Payment funded and locked successfully",
    payment,
  });
});

// =====================================================
// ROUTE 4: Approve / Release a locked payment
// Transition: locked -> released
// =====================================================
app.post("/approve-payment/:id", (req, res) => {
  const { id } = req.params;
  console.log("✅ [APPROVE-PAYMENT]", id);

  const payment = findPayment(id);
  if (!payment) {
    return res.status(404).json({
      success: false,
      message: "Payment not found",
    });
  }

  // 🚨 STRICT CHECK: Only "locked" payments can be released
  if (payment.status !== "locked") {
    return res.status(400).json({
      success: false,
      message: `Cannot release. Payment is '${payment.status}', must be 'locked'`,
    });
  }

  payment.status = "released";
  payment.releasedAt = new Date().toISOString();
  console.log("🚀 Payment released:", id);

  return res.json({
    success: true,
    message: "Payment released successfully",
    payment,
  });
});

// =====================================================
// ROUTE 5: Get all payments
// =====================================================
app.get("/payments", (req, res) => {
  return res.json({
    success: true,
    message: "Payments fetched",
    payments,
  });
});

// =====================================================
// ROUTE 6: Reset all payments (clears in-memory storage)
// =====================================================
app.delete("/reset", (req, res) => {
  const count = payments.length;
  payments = [];
  paymentCounter = 1;
  console.log("🗑️ Reset all payments. Cleared:", count);

  return res.json({
    success: true,
    message: `Reset complete. Cleared ${count} payment(s).`,
    payments: [],
  });
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log("================================================");
  console.log(`🚀 FlowPayX running at: http://localhost:${PORT}`);
  console.log("================================================");
});