// =============================================
// SMART PARKING SYSTEM — SHARED APP DATA & LOGIC
// =============================================

// ─── PARKING DATA ─────────────────────────────
// 48 slots across 4 zones (A,B,C,D), each with 12 slots
const ZONES = ['A','B','C','D'];
const SLOTS_PER_ZONE = 12;

function generateParkingData() {
  const data = [];
  const statuses = ['free','free','free','occupied','free','free','occupied','free','free','reserved','free','occupied'];
  ZONES.forEach(zone => {
    for (let i = 1; i <= SLOTS_PER_ZONE; i++) {
      const slotNum = `${zone}${i.toString().padStart(2,'0')}`;
      const idx = (i - 1) % statuses.length;
      const slotType = (i % 4 === 0) ? 'handicap' : (i % 5 === 0 ? 'ev' : 'regular');
      const basePrice = slotType === 'ev' ? 30 : (slotType === 'handicap' ? 15 : 20);
      
      data.push({
        id: slotNum,
        zone: zone,
        number: i,
        status: statuses[idx],
        sensor: statuses[idx] === 'free' ? 0 : 1,
        distanceCm: statuses[idx] === 'free' ? 185 + Math.floor(Math.random()*30) : 25 + Math.floor(Math.random()*15),
        rssiDbm: -55 - Math.floor(Math.random()*20),
        batteryLevel: 92 + Math.floor(Math.random()*8),
        floor: zone <= 'B' ? 'Ground Floor' : 'First Floor',
        type: slotType,
        baseRate: basePrice,
        lastUpdated: new Date().toISOString(),
        reservedBy: statuses[idx] === 'reserved' ? 'User #42' : null,
      });
    }
  });
  return data;
}

let parkingData = generateParkingData();

// ─── DYNAMIC PRICING ENGINE ───────────────────
function getDynamicRateInfo(slotId = null) {
  const totalSlots = parkingData.length;
  const occupiedCount = parkingData.filter(s => s.status === 'occupied' || s.status === 'reserved').length;
  const occupancyRatio = occupiedCount / totalSlots;
  
  let surgeMultiplier = 1.0;
  let surgeLabel = "STANDARD RATE";
  let surgeBadgeClass = "badge-green";

  if (occupancyRatio >= 0.75) {
    surgeMultiplier = 1.5;
    surgeLabel = "⚡ HIGH SURGE (+50%)";
    surgeBadgeClass = "badge-red";
  } else if (occupancyRatio >= 0.50) {
    surgeMultiplier = 1.25;
    surgeLabel = "⚡ MODERATE SURGE (+25%)";
    surgeBadgeClass = "badge-yellow";
  }

  let slot = slotId ? parkingData.find(s => s.id === slotId) : null;
  let baseRate = slot ? slot.baseRate : 20;
  let hourlyRate = Math.round(baseRate * surgeMultiplier);

  return {
    occupancyRatio: Math.round(occupancyRatio * 100),
    surgeMultiplier,
    surgeLabel,
    surgeBadgeClass,
    baseRate,
    hourlyRate,
    occupiedCount,
    freeCount: totalSlots - occupiedCount
  };
}

// ─── CANCELLATION POLICY & REFUND LOGIC ───────
let cancellationPolicy = JSON.parse(localStorage.getItem('sp_cancel_policy') || JSON.stringify({
  refundPct: 50,          // 50% refund of total booking amount
  partialRefundPct: 50,   // 50% refund rate
  allowAfterStart: true   // Allow cancellation at any time with 50% refund
}));

// Force 50% refund policy
cancellationPolicy.refundPct = 50;
cancellationPolicy.partialRefundPct = 50;
cancellationPolicy.allowAfterStart = true;
localStorage.setItem('sp_cancel_policy', JSON.stringify(cancellationPolicy));

function saveCancellationPolicy(policy) {
  cancellationPolicy = policy;
  localStorage.setItem('sp_cancel_policy', JSON.stringify(policy));
}

function calculateRefund(booking) {
  // Always allow cancellation with a guaranteed 50% refund
  const refundPct = 50;
  const refundAmt = Math.round((booking.amount * refundPct) / 100);

  return {
    allowed: true,
    refundPct: refundPct,
    refundAmount: refundAmt,
    reason: `50% Refund Policy: 50% of ₹${booking.amount} = ₹${refundAmt} credited to your SmartPark Wallet`
  };
}


// ─── MOCK BACKEND REST API & NETWORK LOGS ────
let apiLogs = [];

function logApiCall(method, endpoint, status, responseData) {
  const log = {
    id: 'REQ-' + Math.floor(1000 + Math.random()*9000),
    method,
    endpoint,
    status,
    timestamp: new Date().toLocaleTimeString(),
    latencyMs: Math.floor(12 + Math.random() * 45),
    response: responseData
  };
  apiLogs.unshift(log);
  if (apiLogs.length > 20) apiLogs.pop();
  
  if (typeof renderApiLogs === 'function') renderApiLogs();
  if (typeof renderTabApiLogs === 'function') renderTabApiLogs();
}

const MockAPI = {
  async getSlots() {
    logApiCall('GET', '/api/v1/slots', 200, { count: parkingData.length });
    return JSON.parse(JSON.stringify(parkingData));
  },
  
  async getPricing(slotId) {
    const info = getDynamicRateInfo(slotId);
    logApiCall('GET', `/api/v1/pricing/${slotId || 'current'}`, 200, info);
    return info;
  },
  
  async toggleSlotSensor(slotId, targetStatus = null) {
    const slot = parkingData.find(s => s.id === slotId);
    if (!slot) return { status: 404, error: 'Slot not found' };
    
    if (targetStatus) {
      slot.status = targetStatus;
    } else {
      slot.status = slot.status === 'free' ? 'occupied' : 'free';
    }
    slot.sensor = slot.status === 'free' ? 0 : 1;
    slot.distanceCm = slot.status === 'free' ? 190 : 30;
    slot.lastUpdated = new Date().toISOString();

    logApiCall('PUT', `/api/v1/sensors/${slotId}`, 200, { slotId, status: slot.status });
    addIotLog(`Sensor ${slotId} state updated -> ${slot.status.toUpperCase()} (Dist: ${slot.distanceCm}cm)`);
    return { status: 200, slot };
  },

  async createBooking(bookingPayload) {
    const slot = parkingData.find(s => s.id === bookingPayload.slotId);
    if (!slot || slot.status === 'occupied') {
      logApiCall('POST', '/api/v1/bookings', 400, { error: 'Slot unavailable' });
      return { success: false, error: 'Selected slot is no longer available!' };
    }

    const user = getCurrentUser();

    // Process payment via wallet if requested
    if (bookingPayload.paymentMethod === 'WALLET') {
      if (!user) {
        return { success: false, error: 'Please login to pay with Wallet!' };
      }
      if (user.walletBalance < bookingPayload.amount) {
        return { success: false, error: `Insufficient wallet balance! (Available: ₹${user.walletBalance})` };
      }
      user.walletBalance -= bookingPayload.amount;
      saveUser(user);
      addWalletTransaction(user.id, 'DEBIT', bookingPayload.amount, `Slot ${bookingPayload.slotId} Booking`);
    }

    const fullBooking = {
      id: bookingPayload.id,
      userId: bookingPayload.userId || (user ? user.id : 'GUEST'),
      driverName: bookingPayload.driverName,
      vehicleNo: bookingPayload.vehicleNo,
      slotId: bookingPayload.slotId,
      bookingDate: bookingPayload.bookingDate || new Date(bookingPayload.entryTime).toLocaleDateString('en-IN'),
      entryTime: bookingPayload.entryTime,
      startTime: bookingPayload.entryTime,
      endTime: bookingPayload.endTime || new Date(new Date(bookingPayload.entryTime).getTime() + (bookingPayload.hours || 1) * 3600000).toISOString(),
      hours: bookingPayload.hours,
      phone: bookingPayload.phone,
      amount: bookingPayload.amount,
      paymentMethod: bookingPayload.paymentMethod,
      paymentStatus: 'PAID',
      bookingStatus: 'CONFIRMED',
      status: 'CONFIRMED',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      refundAmount: 0,
      refundStatus: null,
      reminder_sent: false,
      reminder_sent_at: null,
      extensions: []
    };

    slot.status = 'reserved';
    slot.reservedBy = fullBooking.driverName;

    bookings.unshift(fullBooking);
    saveBookings();

    logApiCall('POST', '/api/v1/bookings', 201, { bookingId: fullBooking.id, amount: fullBooking.amount });
    addIotLog(`Booking Confirmed: ${fullBooking.id} for Slot ${fullBooking.slotId} (Valid until ${new Date(fullBooking.endTime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})})`);

    return { success: true, booking: fullBooking };
  },

  async cancelBooking(bookingId, triggeredByAdmin = false) {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { success: false, error: 'Booking not found!' };

    const user = getCurrentUser();

    // Verification: user can only cancel their own booking (unless admin)
    if (!triggeredByAdmin && user && booking.userId && booking.userId !== user.id && booking.driverName !== user.name) {
      return { success: false, error: 'Unauthorized: You can only cancel your own bookings.' };
    }

    // State validation
    if (booking.bookingStatus === 'CANCELLED' || booking.status === 'CANCELLED') {
      return { success: false, error: 'Booking has already been cancelled.' };
    }
    if (booking.bookingStatus === 'COMPLETED' || booking.bookingStatus === 'EXPIRED') {
      return { success: false, error: 'Completed or expired bookings cannot be cancelled.' };
    }

    const refundCalc = calculateRefund(booking);
    if (!refundCalc.allowed && !triggeredByAdmin) {
      return { success: false, error: `Cancellation Not Allowed. Reason: ${refundCalc.reason}` };
    }

    const refundAmt = refundCalc.refundAmount;

    // 1. Change booking status to Cancelled
    booking.bookingStatus = 'CANCELLED';
    booking.status = 'CANCELLED';
    booking.cancelledAt = new Date().toISOString();
    booking.refundAmount = refundAmt;
    booking.refundStatus = refundAmt > 0 ? 'REFUNDED' : 'NO_REFUND';
    booking.paymentStatus = refundAmt > 0 ? 'REFUNDED' : booking.paymentStatus;
    saveBookings();

    // 2. Change parking slot status from Booked (reserved) to Available (free)
    const slot = parkingData.find(s => s.id === booking.slotId);
    if (slot) {
      slot.status = 'free';
      slot.sensor = 0;
      slot.distanceCm = 190;
      slot.reservedBy = null;
      slot.lastUpdated = new Date().toISOString();
    }

    // 3. Process refund to user's SmartPark Wallet
    if (refundAmt > 0 && user) {
      user.walletBalance = (user.walletBalance || 0) + refundAmt;
      saveUser(user);
      addWalletTransaction(user.id, 'CREDIT', refundAmt, `Refund for Cancelled Slot ${booking.slotId} (${booking.id})`);
    }

    // 4. Log REST API Call and Telemetry
    logApiCall('DELETE', `/api/v1/bookings/${bookingId}`, 200, {
      bookingId,
      status: 'CANCELLED',
      slotId: booking.slotId,
      refundAmount: refundAmt
    });
    addIotLog(`Booking ${bookingId} CANCELLED. Slot ${booking.slotId} is now AVAILABLE. Refund ₹${refundAmt} processed.`);

    // 5. Refresh all active UI components
    if (typeof updatePageSlotData === 'function') updatePageSlotData();
    if (typeof renderMap === 'function') renderMap();
    if (typeof renderTabMap === 'function') renderTabMap();
    if (typeof renderAdminTable === 'function') renderAdminTable();
    if (typeof renderTabAdmin === 'function') renderTabAdmin();
    if (typeof renderMyBookingsUI === 'function') renderMyBookingsUI();

    return {
      success: true,
      booking,
      refundAmount: refundAmt,
      slotId: booking.slotId
    };
  },

  async extendBooking(bookingId, additionalMinutes = 30, paymentMethod = 'WALLET') {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { success: false, error: 'Booking not found!' };

    if (booking.bookingStatus !== 'CONFIRMED' && booking.status !== 'CONFIRMED') {
      return { success: false, error: `Cannot extend booking with status: ${booking.bookingStatus || booking.status}` };
    }

    const currentEndTime = new Date(booking.endTime);
    const newEndTime = new Date(currentEndTime.getTime() + additionalMinutes * 60000);

    // Conflict detection: Ensure no overlapping booking exists on this slot
    const conflict = bookings.find(b =>
      b.id !== bookingId &&
      b.slotId === booking.slotId &&
      (b.bookingStatus === 'CONFIRMED' || b.status === 'CONFIRMED') &&
      new Date(b.startTime || b.entryTime) < newEndTime &&
      new Date(b.endTime) > currentEndTime
    );

    if (conflict) {
      const conflictStart = new Date(conflict.startTime || conflict.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return {
        success: false,
        error: `Extension unavailable. Another booking (${conflict.id}) exists for Slot ${booking.slotId} starting at ${conflictStart}.`
      };
    }

    // Dynamic price calculation
    const rateInfo = getDynamicRateInfo(booking.slotId);
    const additionalHours = additionalMinutes / 60;
    const additionalAmount = Math.round(additionalHours * rateInfo.hourlyRate);

    const user = getCurrentUser();
    if (paymentMethod === 'WALLET' && user) {
      if ((user.walletBalance || 0) < additionalAmount) {
        return { success: false, error: `Insufficient wallet balance! (Required: ₹${additionalAmount}, Available: ₹${user.walletBalance || 0})` };
      }
      user.walletBalance -= additionalAmount;
      saveUser(user);
      addWalletTransaction(user.id, 'DEBIT', additionalAmount, `Extension +${additionalMinutes}m for Slot ${booking.slotId}`);
    }

    const prevEndTimeFormatted = currentEndTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newEndTimeFormatted = newEndTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    booking.endTime = newEndTime.toISOString();
    booking.hours = parseFloat(((booking.hours || 1) + additionalHours).toFixed(2));
    booking.amount += additionalAmount;
    booking.reminder_sent = false; // Reset so next 15-min reminder triggers before new end time!
    booking.reminder_sent_at = null;
    booking.extensions = booking.extensions || [];
    booking.extensions.push({
      extendedAt: new Date().toISOString(),
      additionalMinutes,
      additionalAmount,
      prevEndTime: currentEndTime.toISOString(),
      newEndTime: newEndTime.toISOString()
    });

    saveBookings();

    logApiCall('POST', `/api/v1/bookings/${bookingId}/extend`, 200, {
      bookingId,
      slotId: booking.slotId,
      additionalMinutes,
      additionalAmount,
      newEndTime: newEndTime.toISOString()
    });
    addIotLog(`[EXTENSION SUCCESS] Booking ${booking.id} on Slot ${booking.slotId} extended by ${additionalMinutes}m to ${newEndTimeFormatted}`);

    addSystemNotification({
      id: 'NOTIF-' + Math.floor(1000 + Math.random()*9000),
      type: 'EXTENSION_CONFIRMED',
      bookingId: booking.id,
      slotId: booking.slotId,
      message: `✅ Parking for Slot ${booking.slotId} extended by ${additionalMinutes} mins. New End Time: ${newEndTimeFormatted}.`,
      timestamp: new Date().toISOString(),
      read: false
    });

    dismissFloatingReminder();

    if (typeof renderMyBookingsUI === 'function') renderMyBookingsUI();
    if (typeof renderAdminTable === 'function') renderAdminTable();
    if (typeof renderTabAdmin === 'function') renderTabAdmin();

    return {
      success: true,
      booking,
      newEndTime: newEndTimeFormatted,
      additionalAmount,
      additionalMinutes
    };
  }
};

// ─── BOOKINGS DATA ─────────────────────────────
let bookings = JSON.parse(localStorage.getItem('sp_bookings') || '[]');

function saveBookings() {
  localStorage.setItem('sp_bookings', JSON.stringify(bookings));
}

// ─── AUTH & WALLET DATA SYSTEM ────────────────
let currentUser = JSON.parse(localStorage.getItem('sp_user') || 'null');

if (!currentUser) {
  currentUser = {
    id: 'USR-7092',
    name: 'Alex Rivera',
    email: 'alex.rivera@smartpark.io',
    role: 'driver',
    walletBalance: 850,
    avatar: '👨‍💼',
    plate: 'KA 01 AB 4321'
  };
  localStorage.setItem('sp_user', JSON.stringify(currentUser));
}

function getCurrentUser() {
  return JSON.parse(localStorage.getItem('sp_user') || 'null');
}

function saveUser(user) {
  currentUser = user;
  localStorage.setItem('sp_user', JSON.stringify(user));
  updateUserNavUI();
}

function loginUser(userObj) {
  saveUser(userObj);
  showToast(`Welcome back, ${userObj.name}! 👋`, 'success');
}

function logoutUser() {
  localStorage.removeItem('sp_user');
  currentUser = null;
  showToast('Logged out successfully', 'info');
  updateUserNavUI();
}

function topUpWallet(amount) {
  const user = getCurrentUser();
  if (!user) return;
  user.walletBalance = (user.walletBalance || 0) + amount;
  saveUser(user);
  addWalletTransaction(user.id, 'CREDIT', amount, 'Wallet Top-Up');
  showToast(`Added ₹${amount} to SmartPark Wallet! Balance: ₹${user.walletBalance}`, 'success');
}

let walletTxns = JSON.parse(localStorage.getItem('sp_txns') || '[]');
function addWalletTransaction(userId, type, amount, desc) {
  walletTxns.unshift({
    id: 'TXN-' + Date.now().toString().slice(-6),
    userId,
    type,
    amount,
    desc,
    date: new Date().toLocaleString()
  });
  localStorage.setItem('sp_txns', JSON.stringify(walletTxns));
}

// ─── IOT LOG TELEMETRY SYSTEM ─────────────────
let iotLogs = [
  `[MQTT Gateway] Connected to broker mqtt://iot.smartpark.io:1883`,
  `[ESP32-Node-01] Calibrated ultrasonic sensors for Zone A & B`,
  `[System Telemetry] Dynamic pricing & Cancellation engine online`
];

function addIotLog(msg) {
  const time = new Date().toLocaleTimeString();
  iotLogs.unshift(`[${time}] ${msg}`);
  if (iotLogs.length > 50) iotLogs.pop();
  if (typeof renderIotLogFeed === 'function') {
    renderIotLogFeed();
  }
}

// ─── UTILITIES ────────────────────────────────
function formatCurrency(amount) {
  return '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 0 });
}

function formatDateTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function generateQRData(bookingId) {
  return `SMARTPARK|${bookingId}|${Date.now()}`;
}

function generateBookingId() {
  return 'SP' + Date.now().toString().slice(-8) + Math.floor(Math.random()*90 + 10);
}

// ─── TOAST NOTIFICATION ───────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── MODAL ────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'flex';
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'none';
}

// ─── SIMULATE REAL-TIME IOT UPDATES ───────────
let iotSimInterval = null;
let iotSimActive = true;

function toggleIotSim(activeState = null) {
  iotSimActive = activeState !== null ? activeState : !iotSimActive;
  if (!iotSimActive) {
    if (iotSimInterval) clearInterval(iotSimInterval);
    addIotLog(`IoT sensor simulation paused by operator`);
  } else {
    startIotSim();
    addIotLog(`IoT sensor simulation resumed (Interval: 5s)`);
  }
  return iotSimActive;
}

function startIotSim(onUpdateCallback = null) {
  if (iotSimInterval) clearInterval(iotSimInterval);
  iotSimInterval = setInterval(() => {
    if (!iotSimActive) return;
    const numChanges = Math.floor(Math.random() * 2) + 1;
    for (let c = 0; c < numChanges; c++) {
      const idx = Math.floor(Math.random() * parkingData.length);
      const slot = parkingData[idx];
      if (slot.status === 'reserved') continue;
      
      const newStatus = slot.status === 'free' ? 'occupied' : 'free';
      slot.status = newStatus;
      slot.sensor = newStatus === 'free' ? 0 : 1;
      slot.distanceCm = newStatus === 'free' ? 180 + Math.floor(Math.random()*20) : 20 + Math.floor(Math.random()*15);
      slot.lastUpdated = new Date().toISOString();

      addIotLog(`Sensor ${slot.id} triggered -> ${newStatus.toUpperCase()}`);
    }
    
    if (onUpdateCallback) onUpdateCallback(parkingData);
    if (typeof updatePageSlotData === 'function') updatePageSlotData();
  }, 5000);
}

// ─── CANVAS QR CODE GENERATOR ─────────────────
function renderCanvasQR(canvasId, textData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = canvas.width || 140;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  
  ctx.fillStyle = '#0f172a';
  const grid = 21;
  const cellSize = size / grid;

  let hash = 0;
  for (let i = 0; i < textData.length; i++) {
    hash = (hash << 5) - hash + textData.charCodeAt(i);
    hash |= 0;
  }

  function drawFinder(x, y) {
    ctx.fillRect(x*cellSize, y*cellSize, 7*cellSize, 7*cellSize);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((x+1)*cellSize, (y+1)*cellSize, 5*cellSize, 5*cellSize);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect((x+2)*cellSize, (y+2)*cellSize, 3*cellSize, 3*cellSize);
  }

  drawFinder(0, 0);
  drawFinder(14, 0);
  drawFinder(0, 14);

  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      if ((r < 7 && c < 7) || (r < 7 && c > 13) || (r > 13 && c < 7)) continue;
      const val = Math.abs(Math.sin((r * grid + c) * hash));
      if (val > 0.45) {
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
  }
}

// ─── PRINT / PDF RECEIPT EXPORTER ─────────────
function exportBookingReceiptPDF(booking) {
  const printWin = window.open('', '_blank', 'width=800,height=900');
  if (!printWin) {
    showToast('Please allow popups to download/print your ticket!', 'error');
    return;
  }

  const isCancelled = booking.bookingStatus === 'CANCELLED' || booking.status === 'CANCELLED';
  const badgeHtml = isCancelled
    ? `<span class="badge" style="background:#fee2e2; color:#991b1b;">✕ BOOKING CANCELLED (Refund: ₹${booking.refundAmount || 0})</span>`
    : `<span class="badge" style="background:#dcfce7; color:#166534;">✓ VERIFIED & PAID</span>`;
  
  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>SmartPark Ticket - ${booking.id}</title>
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; color: #0f172a; padding: 40px; }
      .ticket { max-width: 600px; margin: 0 auto; background: #fff; border: 2px dashed ${isCancelled ? '#ef4444' : '#6366f1'}; border-radius: 20px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
      .header { text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 24px; }
      .header h1 { margin: 0; color: #6366f1; font-size: 28px; }
      .header p { color: #64748b; margin: 4px 0 0 0; }
      .badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-top: 10px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; background: #f1f5f9; padding: 20px; border-radius: 12px; }
      .label { font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: bold; }
      .val { font-size: 18px; font-weight: bold; color: #0f172a; margin-top: 4px; }
      .qr-area { text-align: center; margin: 24px 0; padding: 20px; background: #fafafa; border-radius: 16px; border: 1px solid #e2e8f0; }
      .qr-code { font-family: monospace; font-size: 24px; letter-spacing: 4px; font-weight: bold; color: #4338ca; }
      .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 16px; }
      .btn-print { background: #6366f1; color: white; border: none; padding: 12px 24px; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; display: block; margin: 20px auto 0 auto; }
      @media print { .btn-print { display: none; } }
    </style>
  </head>
  <body>
    <div class="ticket">
      <div class="header">
        <h1>🅿️ SmartPark Pass & Receipt</h1>
        <p>Official IoT Gate Entry & Parking Record</p>
        ${badgeHtml}
      </div>

      <div class="grid">
        <div>
          <div class="label">Booking Reference</div>
          <div class="val">${booking.id}</div>
        </div>
        <div>
          <div class="label">Assigned Slot</div>
          <div class="val" style="color:#6366f1;">Slot ${booking.slotId}</div>
        </div>
        <div>
          <div class="label">Driver Name</div>
          <div class="val">${booking.driverName}</div>
        </div>
        <div>
          <div class="label">Vehicle Registration</div>
          <div class="val">${booking.vehicleNo}</div>
        </div>
        <div>
          <div class="label">Entry Reserved Time</div>
          <div class="val">${new Date(booking.entryTime).toLocaleString('en-IN')}</div>
        </div>
        <div>
          <div class="label">Duration & Amount</div>
          <div class="val">${booking.hours} hrs (₹${booking.amount})</div>
        </div>
        ${isCancelled ? `
        <div>
          <div class="label">Cancelled At</div>
          <div class="val" style="color:#ef4444;">${new Date(booking.cancelledAt).toLocaleString('en-IN')}</div>
        </div>
        <div>
          <div class="label">Refund Status</div>
          <div class="val" style="color:#10b981;">₹${booking.refundAmount || 0} (${booking.refundStatus || 'Refunded'})</div>
        </div>
        ` : ''}
      </div>

      <div class="qr-area">
        <div style="font-size:14px; color:#64748b; margin-bottom:10px;">SCAN AT BARRIER SCANNER</div>
        <div class="qr-code">||| |||| || |||||| | ${booking.id}</div>
        <div style="margin-top:10px; font-size:12px; color:#64748b;">Payment Method: ${booking.paymentMethod} • Status: ${booking.bookingStatus || booking.status}</div>
      </div>

      <div class="footer">
        SmartPark IoT Infrastructure • Support Helpline: +91 1800-SMARTPARK<br/>
        Generated on ${new Date().toLocaleString('en-IN')}
      </div>

      <button class="btn-print" onclick="window.print()">📥 Print / Save PDF</button>
    </div>
  </body>
  </html>
  `;
  
  printWin.document.write(htmlContent);
  printWin.document.close();
}

// ─── NOTIFICATION SYSTEM & STORAGE ────────────
let systemNotifications = JSON.parse(localStorage.getItem('sp_notifications') || '[]');

function saveNotifications() {
  localStorage.setItem('sp_notifications', JSON.stringify(systemNotifications));
  updateNotificationNavBadge();
}

function addSystemNotification(notif) {
  systemNotifications.unshift(notif);
  if (systemNotifications.length > 50) systemNotifications.pop();
  saveNotifications();
  if (document.getElementById('notificationsModal') && document.getElementById('notificationsModal').style.display !== 'none') {
    renderNotificationsUI();
  }
}

function updateNotificationNavBadge() {
  const badge = document.getElementById('navNotifBadge');
  const unreadCount = systemNotifications.filter(n => !n.read).length;
  if (badge) {
    badge.textContent = unreadCount;
    badge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
  }
}

function markNotificationAsRead(notifId) {
  const n = systemNotifications.find(item => item.id === notifId);
  if (n) {
    n.read = true;
    saveNotifications();
    renderNotificationsUI();
  }
}

function clearAllNotifications() {
  systemNotifications = [];
  saveNotifications();
  renderNotificationsUI();
  showToast('All notifications cleared.', 'info');
}

function requestBrowserNotificationPermission() {
  if ('Notification' in window) {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        showToast('Browser notifications enabled! You will receive background reminders.', 'success');
      } else {
        showToast('Browser notification permission was not granted.', 'warning');
      }
    });
  } else {
    showToast('Browser Notifications are not supported in this environment.', 'info');
  }
}

function sendBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body: body,
        icon: '🅿️',
        tag: 'smartpark-reminder',
        renotify: true
      });
    } catch (err) {
      console.warn('Browser push notification could not be dispatched:', err);
    }
  }
}

function renderNotificationsUI() {
  const container = document.getElementById('notificationsListContainer');
  if (!container) return;

  if (systemNotifications.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:36px; color:var(--text-muted); background:var(--bg-secondary); border-radius:var(--radius-md);">
        <div style="font-size:2.2rem; margin-bottom:8px;">🔔</div>
        <p style="font-size:0.9rem;">No notifications right now.</p>
        <span style="font-size:0.75rem;">15-minute slot expiry reminders & booking alerts will appear here.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = systemNotifications.map(n => {
    const isExpiry = n.type === 'EXPIRY_REMINDER';
    const isExtension = n.type === 'EXTENSION_CONFIRMED';
    const isExpired = n.type === 'BOOKING_EXPIRED';
    
    let icon = '🔔';
    let badgeClass = 'badge-purple';
    if (isExpiry) { icon = '⚠️'; badgeClass = 'badge-yellow'; }
    else if (isExtension) { icon = '✅'; badgeClass = 'badge-green'; }
    else if (isExpired) { icon = '⏰'; badgeClass = 'badge-red'; }

    return `
      <div class="notif-item ${!n.read ? 'unread' : ''}">
        <div class="flex-between" style="margin-bottom:6px;">
          <div class="flex gap-8" style="align-items:center;">
            <span style="font-size:1.2rem;">${icon}</span>
            <strong style="font-size:0.88rem; color:${isExpiry ? 'var(--yellow)' : 'var(--text-primary)'};">
              ${isExpiry ? 'Slot Expiry Alert' : (isExtension ? 'Extension Confirmed' : (isExpired ? 'Slot Expired' : 'System Notice'))}
            </strong>
            <span class="badge ${badgeClass}" style="font-size:0.7rem;">${n.slotId ? `Slot ${n.slotId}` : 'Booking'}</span>
          </div>
          <span style="font-size:0.75rem; color:var(--text-muted);">
            ${new Date(n.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
          </span>
        </div>

        <p style="font-size:0.84rem; line-height:1.4; color:var(--text-secondary); margin-bottom:10px;">
          ${n.message}
        </p>

        <div class="flex gap-8" style="justify-content:flex-end;">
          ${isExpiry && n.bookingId ? `
            <button class="btn btn-warning btn-sm" style="padding:4px 10px; font-size:0.75rem; background:var(--yellow); color:#000; font-weight:700;" onclick="closeModal('notificationsModal'); promptExtendBooking('${n.bookingId}');">
              ⏳ Extend Parking
            </button>
          ` : ''}
          ${!n.read ? `
            <button class="btn btn-ghost btn-sm" style="padding:4px 8px; font-size:0.75rem;" onclick="markNotificationAsRead('${n.id}')">
              Mark Read
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function openNotificationsModal() {
  renderNotificationsUI();
  openModal('notificationsModal');
}

// ─── FLOATING INTERACTIVE EXPIRY TOAST ────────
function showFloatingExpiryReminder(booking, remainingMinutes, endTimeFormatted) {
  dismissFloatingReminder();

  const container = document.createElement('div');
  container.id = 'floatingReminderToast';
  container.className = 'floating-reminder-toast';
  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:1.3rem;">⚠️</span>
        <div>
          <strong style="color:var(--yellow); font-size:0.95rem;">Parking Expiry Reminder</strong>
          <div style="font-size:0.72rem; color:var(--text-secondary);">Ref: ${booking.id} • ${booking.driverName}</div>
        </div>
      </div>
      <button onclick="dismissFloatingReminder()" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:1.1rem; padding:0 4px;">✕</button>
    </div>

    <p style="font-size:0.85rem; line-height:1.45; margin-bottom:12px; color:#e2e8f0;">
      Your parking slot <strong style="color:var(--accent-light);">Slot ${booking.slotId}</strong> will expire in <strong style="color:var(--yellow); font-size:0.95rem;">${remainingMinutes} minutes</strong> at <strong style="color:#fff;">${endTimeFormatted}</strong>. Please remove your vehicle or extend your parking time.
    </p>

    <div class="flex gap-8">
      <button class="btn btn-warning btn-sm" style="flex:1; justify-content:center; background:var(--yellow); color:#000; font-weight:700;" onclick="promptExtendBooking('${booking.id}'); dismissFloatingReminder();">
        ⏳ Extend Parking
      </button>
      <button class="btn btn-ghost btn-sm" style="padding:6px 12px;" onclick="dismissFloatingReminder()">
        Dismiss
      </button>
    </div>
  `;
  document.body.appendChild(container);
}

function dismissFloatingReminder() {
  const el = document.getElementById('floatingReminderToast');
  if (el) el.remove();
}

// ─── AUTOMATIC 15-MINUTE REMINDER & EXPIRY SCHEDULER ───
function checkBookingExpirationsAndReminders() {
  const now = Date.now();
  let stateModified = false;

  bookings.forEach(b => {
    if (b.bookingStatus === 'CONFIRMED' || b.status === 'CONFIRMED') {
      const endMs = new Date(b.endTime).getTime();
      const diffMs = endMs - now;
      const diffMinutes = Math.ceil(diffMs / 60000);

      // 1. 15-Minute Reminder Condition: remaining time <= 15m and > 0, reminder_sent is false
      if (diffMinutes <= 15 && diffMinutes > 0 && !b.reminder_sent) {
        b.reminder_sent = true;
        b.reminder_sent_at = new Date().toISOString();
        stateModified = true;

        const endFormatted = new Date(b.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const reminderMsg = `⚠️ Parking Reminder: Your parking slot ${b.slotId} will expire in ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} at ${endFormatted}. Please remove your vehicle or extend your parking time.`;

        // 1. In-App Notification Center
        addSystemNotification({
          id: 'NOTIF-' + Math.floor(1000 + Math.random()*9000),
          type: 'EXPIRY_REMINDER',
          bookingId: b.id,
          slotId: b.slotId,
          endTime: b.endTime,
          message: reminderMsg,
          timestamp: new Date().toISOString(),
          read: false
        });

        // 2. Interactive Toast / Floating Banner
        showFloatingExpiryReminder(b, diffMinutes, endFormatted);

        // 3. Browser background notification
        sendBrowserNotification(`⚠️ Parking Slot ${b.slotId} Expiring Soon!`, reminderMsg);

        // 4. Log REST API Call & IoT telemetry
        logApiCall('POST', `/api/v1/notifications/expiry-reminder`, 200, {
          bookingId: b.id,
          slotId: b.slotId,
          diffMinutes,
          endTime: b.endTime
        });
        addIotLog(`[15-MIN EXPIRY ALERT] Slot ${b.slotId} expires at ${endFormatted}. Reminder dispatched.`);
      }

      // 2. After Parking Time Ends Condition: remaining time <= 0
      if (diffMs <= 0) {
        b.bookingStatus = 'EXPIRED';
        b.status = 'EXPIRED';
        b.expiredAt = new Date().toISOString();
        stateModified = true;

        const slot = parkingData.find(s => s.id === b.slotId);
        if (slot) {
          // If vehicle is physically not occupied, free slot immediately
          if (slot.sensor === 0 || slot.status === 'reserved') {
            slot.status = 'free';
            slot.sensor = 0;
            slot.distanceCm = 190;
            slot.reservedBy = null;
            slot.lastUpdated = new Date().toISOString();
          }
        }

        addSystemNotification({
          id: 'NOTIF-' + Math.floor(1000 + Math.random()*9000),
          type: 'BOOKING_EXPIRED',
          bookingId: b.id,
          slotId: b.slotId,
          endTime: b.endTime,
          message: `⏰ Parking reservation for Slot ${b.slotId} has reached its end time and is now expired.`,
          timestamp: new Date().toISOString(),
          read: false
        });

        dismissFloatingReminder();
      }
    }
  });

  if (stateModified) {
    saveBookings();
    if (typeof renderMyBookingsUI === 'function') renderMyBookingsUI();
    if (typeof renderAdminTable === 'function') renderAdminTable();
    if (typeof renderTabAdmin === 'function') renderTabAdmin();
    if (typeof renderMap === 'function') renderMap();
    if (typeof renderTabMap === 'function') renderTabMap();
  }
}

function startExpiryReminderScheduler() {
  checkBookingExpirationsAndReminders();
  setInterval(checkBookingExpirationsAndReminders, 4000);
}

// ─── FAST-FORWARD / TEST SIMULATION HELPER ────
function simulateBookingExpiry(bookingId) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) {
    showToast('Booking not found to simulate!', 'error');
    return;
  }
  const simEnd = new Date(Date.now() + 14.5 * 60000); // 14.5 minutes left
  booking.endTime = simEnd.toISOString();
  booking.reminder_sent = false;
  booking.reminder_sent_at = null;
  booking.bookingStatus = 'CONFIRMED';
  booking.status = 'CONFIRMED';
  saveBookings();

  showToast(`⏱️ Expiry simulation started! Slot ${booking.slotId} set to expire in 14.5 mins (${simEnd.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}).`, 'info', 4000);
  checkBookingExpirationsAndReminders();
}

// ─── EXTEND PARKING MODAL & HANDLERS ──────────
let currentExtendBookingId = null;
let selectedExtendMinutes = 30;

function promptExtendBooking(bookingId) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) {
    showToast('Booking not found!', 'error');
    return;
  }
  currentExtendBookingId = bookingId;
  selectedExtendMinutes = 30;

  const currentEnd = new Date(booking.endTime);
  document.getElementById('extSlotDisplay').textContent = `Slot ${booking.slotId}`;
  document.getElementById('extBookingIdDisplay').textContent = booking.id;
  document.getElementById('extDriverDisplay').textContent = `${booking.driverName} (${booking.vehicleNo})`;
  document.getElementById('extCurrentEndDisplay').textContent = currentEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + currentEnd.toLocaleDateString('en-IN') + ')';

  // Dynamic price calculation
  const rateInfo = getDynamicRateInfo(booking.slotId);
  const cost30m = Math.round(0.5 * rateInfo.hourlyRate);
  const cost1h = Math.round(1.0 * rateInfo.hourlyRate);
  const cost2h = Math.round(2.0 * rateInfo.hourlyRate);

  document.getElementById('extCost30m').textContent = `+ ₹${cost30m}`;
  document.getElementById('extCost1h').textContent = `+ ₹${cost1h}`;
  document.getElementById('extCost2h').textContent = `+ ₹${cost2h}`;

  document.querySelectorAll('.ext-option-card').forEach(c => c.classList.remove('selected'));
  const defaultCard = document.querySelector('.ext-option-card[data-mins="30"]');
  if (defaultCard) defaultCard.classList.add('selected');

  updateExtendModalPreview();
  openModal('extendParkingModal');
}

function selectExtendOption(minutes, el) {
  selectedExtendMinutes = minutes;
  document.querySelectorAll('.ext-option-card').forEach(c => c.classList.remove('selected'));
  if (el) el.classList.add('selected');
  updateExtendModalPreview();
}

function updateExtendModalPreview() {
  const booking = bookings.find(b => b.id === currentExtendBookingId);
  if (!booking) return;

  const currentEnd = new Date(booking.endTime);
  const newEnd = new Date(currentEnd.getTime() + selectedExtendMinutes * 60000);
  const rateInfo = getDynamicRateInfo(booking.slotId);
  const cost = Math.round((selectedExtendMinutes / 60) * rateInfo.hourlyRate);

  document.getElementById('extNewEndDisplay').textContent = newEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('extTotalAmountDisplay').textContent = `₹${cost}`;

  // Live conflict detection preview
  const conflict = bookings.find(b =>
    b.id !== booking.id &&
    b.slotId === booking.slotId &&
    (b.bookingStatus === 'CONFIRMED' || b.status === 'CONFIRMED') &&
    new Date(b.startTime || b.entryTime) < newEnd &&
    new Date(b.endTime) > currentEnd
  );

  const alertBox = document.getElementById('extConflictAlert');
  const confirmBtn = document.getElementById('extConfirmBtn');

  if (conflict) {
    const conflictStart = new Date(conflict.startTime || conflict.entryTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    alertBox.style.display = 'block';
    alertBox.innerHTML = `⚠️ <strong>Extension Unavailable:</strong> Another booking (${conflict.id}) is scheduled for Slot ${booking.slotId} starting at ${conflictStart}.`;
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.5';
    confirmBtn.textContent = 'Extension Unavailable';
  } else {
    alertBox.style.display = 'none';
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '1';
    confirmBtn.textContent = 'Confirm Extension';
  }
}

async function confirmExtendBooking() {
  if (!currentExtendBookingId) return;
  const pmEl = document.querySelector('input[name="extPayMethod"]:checked');
  const pm = pmEl ? pmEl.value : 'WALLET';

  const res = await MockAPI.extendBooking(currentExtendBookingId, selectedExtendMinutes, pm);
  if (res.success) {
    closeModal('extendParkingModal');
    showToast(`🎉 Parking extended successfully! New End Time: ${res.newEndTime}`, 'success', 5000);
  } else {
    showToast(res.error, 'error', 5000);
  }
}

// ─── AUTOMATIC GATE CONTROL & HARDWARE ENGINE ──
const gateSystem = {
  entry: {
    state: 'CLOSED', // OPEN, CLOSED, OPENING, CLOSING
    servoAngle: 0,
    sensorDetected: false,
    led: 'RED',
    autoCloseTimer: null,
    currentBooking: null
  },
  exit: {
    state: 'CLOSED',
    servoAngle: 0,
    sensorDetected: false,
    led: 'RED',
    autoCloseTimer: null,
    currentBooking: null
  }
};

function playGateBuzzer(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.12;

    if (type === 'success') {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1760, ctx.currentTime + 0.1);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } else if (type === 'denied') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.setValueAtTime(160, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else if (type === 'warning') {
      osc.frequency.setValueAtTime(650, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }
  } catch (e) {}
}

function setGateState(gateType, state) {
  const gate = gateSystem[gateType];
  if (!gate) return;
  gate.state = state;

  if (state === 'CLOSED') {
    gate.servoAngle = 0;
    gate.led = 'RED';
  } else if (state === 'OPENING') {
    gate.servoAngle = 45;
    gate.led = 'YELLOW';
  } else if (state === 'OPEN') {
    gate.servoAngle = 90;
    gate.led = 'GREEN';
  } else if (state === 'CLOSING') {
    gate.servoAngle = 45;
    gate.led = 'YELLOW';
  }

  // Update DOM across open pages
  const arm = document.getElementById(`${gateType}BarrierArm`);
  const badge = document.getElementById(`${gateType}GateBadge`);
  const led = document.getElementById(`${gateType}GateLed`);
  const angle = document.getElementById(`${gateType}ServoAngle`);

  if (arm) {
    arm.className = `barrier-arm ${state.toLowerCase()}`;
  }
  if (badge) {
    badge.textContent = state;
    badge.className = `badge ${state === 'OPEN' ? 'badge-green' : (state === 'CLOSED' ? 'badge-red' : 'badge-yellow')}`;
  }
  if (led) {
    led.className = `gate-led ${gate.led.toLowerCase()}`;
  }
  if (angle) {
    angle.textContent = `${gate.servoAngle}°`;
  }

  logApiCall('POST', `/api/v1/gates/${gateType}/state`, 200, {
    gate: gateType,
    state,
    servoAngle: gate.servoAngle,
    led: gate.led
  });
}

function setUnderBarrierSensor(gateType, detected) {
  const gate = gateSystem[gateType];
  if (!gate) return;
  gate.sensorDetected = detected;

  const sensorBadge = document.getElementById(`${gateType}SensorBadge`);
  const sensorDesc = document.getElementById(`${gateType}SensorDesc`);

  if (sensorBadge) {
    sensorBadge.textContent = detected ? 'OBSTACLE DETECTED (32cm)' : 'BEAM CLEAR (190cm)';
    sensorBadge.className = `badge ${detected ? 'badge-red' : 'badge-green'}`;
  }
  if (sensorDesc) {
    sensorDesc.textContent = detected
      ? '⚠️ Vehicle detected underneath barrier — Gate held OPEN for safety.'
      : '✅ Barrier zone clear. Safe to close.';
  }

  if (detected) {
    if (gate.autoCloseTimer) {
      clearTimeout(gate.autoCloseTimer);
      gate.autoCloseTimer = null;
    }
    playGateBuzzer('warning');
    addIotLog(`[GATE SAFETY SENSOR] Obstacle detected under ${gateType.toUpperCase()} gate. Gate held OPEN.`);
  } else {
    addIotLog(`[GATE SAFETY SENSOR] ${gateType.toUpperCase()} gate safety zone cleared.`);
    if (gate.state === 'OPEN') {
      showToast(`🚗 Vehicle cleared ${gateType} barrier. Gate will close in 2.5s...`, 'info', 2500);
      gate.autoCloseTimer = setTimeout(() => {
        triggerGateCloseSequence(gateType);
      }, 2500);
    }
  }
}

function triggerGateOpenSequence(gateType, booking = null) {
  const gate = gateSystem[gateType];
  if (!gate) return;

  if (gate.autoCloseTimer) {
    clearTimeout(gate.autoCloseTimer);
    gate.autoCloseTimer = null;
  }

  setGateState(gateType, 'OPENING');
  playGateBuzzer('success');
  addIotLog(`[SERVO ROTATING] ${gateType.toUpperCase()} Gate rotating to 90° (OPEN)...`);

  setTimeout(() => {
    setGateState(gateType, 'OPEN');
    addIotLog(`[GATE OPENED] ${gateType.toUpperCase()} Barrier arm at 90°. Vehicle entry permitted.`);

    // Automatically simulate vehicle passing under barrier
    setTimeout(() => {
      setUnderBarrierSensor(gateType, true);
      setTimeout(() => {
        setUnderBarrierSensor(gateType, false);
      }, 2000);
    }, 800);
  }, 1200);
}

function triggerGateCloseSequence(gateType) {
  const gate = gateSystem[gateType];
  if (!gate) return;

  // Safety guard check: Never close while vehicle is detected under gate!
  if (gate.sensorDetected) {
    showToast(`⚠️ Safety Guard: Cannot close ${gateType} gate — vehicle is detected under barrier!`, 'warning', 4000);
    playGateBuzzer('warning');
    return;
  }

  setGateState(gateType, 'CLOSING');
  playGateBuzzer('warning');
  addIotLog(`[SERVO ROTATING] ${gateType.toUpperCase()} Gate rotating back to 0° (CLOSED)...`);

  setTimeout(() => {
    setGateState(gateType, 'CLOSED');
    addIotLog(`[GATE CLOSED] ${gateType.toUpperCase()} Barrier arm is down and secured.`);

    if (gateType === 'entry' && gate.currentBooking) {
      const slot = parkingData.find(s => s.id === gate.currentBooking.slotId);
      if (slot) {
        slot.status = 'occupied';
        slot.sensor = 1;
        slot.distanceCm = 35;
        slot.lastUpdated = new Date().toISOString();
      }
      gate.currentBooking = null;
      if (typeof renderMap === 'function') renderMap();
      if (typeof renderTabMap === 'function') renderTabMap();
      if (typeof renderSlots === 'function') renderSlots();
      if (typeof renderTabSlots === 'function') renderTabSlots();
    } else if (gateType === 'exit' && gate.currentBooking) {
      const slot = parkingData.find(s => s.id === gate.currentBooking.slotId);
      if (slot) {
        slot.status = 'free';
        slot.sensor = 0;
        slot.distanceCm = 190;
        slot.reservedBy = null;
        slot.lastUpdated = new Date().toISOString();
      }
      gate.currentBooking = null;
      if (typeof renderMap === 'function') renderMap();
      if (typeof renderTabMap === 'function') renderTabMap();
      if (typeof renderSlots === 'function') renderSlots();
      if (typeof renderTabSlots === 'function') renderTabSlots();
    }
  }, 1200);
}

function controlGate(gateType, action) {
  if (action === 'open') {
    triggerGateOpenSequence(gateType);
  } else {
    triggerGateCloseSequence(gateType);
  }
}

function processGateScan(gateType, rawInput) {
  const code = (rawInput || '').trim();
  if (!code) {
    showToast('Please enter or scan a valid Booking QR / RFID code!', 'warning');
    return;
  }

  const booking = bookings.find(b =>
    b.id.toUpperCase() === code.toUpperCase() ||
    code.toUpperCase().includes(b.id.toUpperCase()) ||
    (b.vehicleNo && b.vehicleNo.replace(/\s+/g,'').toUpperCase() === code.replace(/\s+/g,'').toUpperCase())
  );

  if (!booking) {
    playGateBuzzer('denied');
    showToast(`❌ Access Denied: Unrecognized QR/RFID code (${code}). Gate remains CLOSED.`, 'error', 5000);
    logApiCall('POST', `/api/v1/gates/${gateType}/scan`, 404, { code, error: 'Booking Not Found' });
    addIotLog(`[ACCESS DENIED] Unrecognized code ${code} scanned at ${gateType.toUpperCase()} gate.`);
    return;
  }

  if (booking.bookingStatus === 'CANCELLED' || booking.status === 'CANCELLED') {
    playGateBuzzer('denied');
    showToast(`❌ Access Denied: Booking ${booking.id} was CANCELLED & REFUNDED. Gate will NOT open.`, 'error', 6000);
    logApiCall('POST', `/api/v1/gates/${gateType}/scan`, 403, { bookingId: booking.id, status: 'CANCELLED' });
    addIotLog(`[ACCESS DENIED] Booking ${booking.id} is CANCELLED. ${gateType.toUpperCase()} gate remains CLOSED.`);
    return;
  }

  if (booking.bookingStatus === 'EXPIRED' || booking.status === 'EXPIRED') {
    playGateBuzzer('denied');
    showToast(`❌ Access Denied: Booking ${booking.id} has EXPIRED. Please extend or make a new reservation.`, 'error', 6000);
    logApiCall('POST', `/api/v1/gates/${gateType}/scan`, 403, { bookingId: booking.id, status: 'EXPIRED' });
    addIotLog(`[ACCESS DENIED] Booking ${booking.id} has EXPIRED. ${gateType.toUpperCase()} gate remains CLOSED.`);
    return;
  }

  gateSystem[gateType].currentBooking = booking;
  playGateBuzzer('success');
  showToast(`✅ Booking Verified! Slot: ${booking.slotId} (${booking.driverName} - ${booking.vehicleNo}). Gate Opening...`, 'success', 5000);
  logApiCall('POST', `/api/v1/gates/${gateType}/scan`, 200, {
    bookingId: booking.id,
    slotId: booking.slotId,
    status: 'VERIFIED',
    action: 'OPEN_GATE'
  });
  addIotLog(`[ACCESS GRANTED] Verified Booking ${booking.id} at ${gateType.toUpperCase()} gate. Opening barrier arm.`);

  triggerGateOpenSequence(gateType, booking);
}

function openGateTerminalModal(gateType = 'entry') {
  const display = document.getElementById('gateTerminalTypeDisplay');
  const target = document.getElementById('gateTerminalTarget');
  if (display) display.textContent = gateType === 'entry' ? 'Barrier Gate 01 (Entry)' : 'Barrier Gate 02 (Exit)';
  if (target) target.value = gateType;
  renderGateTerminalQuickBookings();
  openModal('gateTerminalModal');
}

function renderGateTerminalQuickBookings() {
  const container = document.getElementById('gateTerminalQuickList');
  if (!container) return;

  if (bookings.length === 0) {
    container.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted);">No bookings recorded. Create one to test scanning.</span>`;
    return;
  }

  container.innerHTML = bookings.slice(0, 6).map(b => {
    const isCancelled = (b.bookingStatus === 'CANCELLED' || b.status === 'CANCELLED');
    const isExpired = (b.bookingStatus === 'EXPIRED' || b.status === 'EXPIRED');
    let color = 'var(--green-light)';
    let label = 'CONFIRMED';
    if (isCancelled) { color = 'var(--red-light)'; label = 'CANCELLED'; }
    else if (isExpired) { color = 'var(--yellow)'; label = 'EXPIRED'; }

    return `
      <button class="btn btn-ghost btn-sm" style="font-size:0.75rem; padding:6px 10px; justify-content:space-between; margin-bottom:6px;" onclick="processGateScan(document.getElementById('gateTerminalTarget').value, '${b.id}')">
        <span><strong>${b.id}</strong> (Slot ${b.slotId} - ${b.driverName})</span>
        <span style="color:${color}; font-weight:700;">${label}</span>
      </button>
    `;
  }).join('');
}

function openEsp32FirmwareModal() {
  openModal('esp32FirmwareModal');
}

// ─── AUTH & WALLET UI NAVBAR INJECTION ────────
function updateUserNavUI() {
  const navActions = document.querySelector('.nav-actions');
  if (!navActions) return;

  const user = getCurrentUser();
  const existingAuth = document.getElementById('navUserContainer');
  if (existingAuth) existingAuth.remove();

  const container = document.createElement('div');
  container.id = 'navUserContainer';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.gap = '10px';

  const unreadNotifs = systemNotifications.filter(n => !n.read).length;

  container.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="openNotificationsModal()" title="View Notifications & Reminders" style="position:relative;">
      🔔 <span class="badge badge-yellow" id="navNotifBadge" style="font-size:0.68rem; padding:2px 6px; ${unreadNotifs > 0 ? '' : 'display:none;'}">${unreadNotifs}</span>
    </button>
    <button class="btn btn-ghost btn-sm" onclick="openMyBookingsModal()" title="View and manage your bookings">
      📋 My Bookings
    </button>
    <button class="btn btn-ghost btn-sm" onclick="openWalletModal()" title="Click to Top up Wallet">
      👛 <span style="color:var(--green-light); font-weight:700;">₹${user ? (user.walletBalance || 0) : 0}</span>
    </button>
    ${user ? `
      <div class="nav-user-badge" onclick="openAuthModal()" style="display:flex; align-items:center; gap:8px; cursor:pointer; background:var(--bg-card); border:1px solid var(--border); padding:6px 12px; border-radius:var(--radius-md);">
        <span style="font-size:1.1rem;">${user.avatar || '👤'}</span>
        <span style="font-weight:600; font-size:0.85rem; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${user.name.split(' ')[0]}</span>
      </div>
    ` : `
      <button class="btn btn-primary btn-sm" onclick="openAuthModal()">🔑 Login</button>
    `}
  `;
  navActions.prepend(container);
}

// ─── CANCEL CONFIRMATION MODAL & MY BOOKINGS LOGIC ───
let pendingCancelBookingId = null;

function promptCancelBooking(bookingId) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) {
    showToast('Booking not found!', 'error');
    return;
  }

  const refundCalc = calculateRefund(booking);
  pendingCancelBookingId = bookingId;

  document.getElementById('cancelSlotDisplay').textContent = `Slot ${booking.slotId}`;
  document.getElementById('cancelDateDisplay').textContent = new Date(booking.entryTime).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric'
  });
  document.getElementById('cancelTimeDisplay').textContent = new Date(booking.entryTime).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit'
  });
  document.getElementById('cancelAmountDisplay').textContent = `₹${booking.amount}`;
  document.getElementById('cancelRefundDisplay').textContent = `₹${refundCalc.refundAmount} (${refundCalc.refundPct}% refund)`;
  document.getElementById('cancelPolicyNote').textContent = refundCalc.reason;

  const confirmBtn = document.getElementById('cancelConfirmBtn');
  if (!refundCalc.allowed) {
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.5';
    confirmBtn.textContent = 'Cancellation Not Allowed';
  } else {
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '1';
    confirmBtn.textContent = 'Yes, Cancel Booking';
  }

  openModal('cancelConfirmModal');
}

async function confirmCancelBooking() {
  if (!pendingCancelBookingId) return;
  const res = await MockAPI.cancelBooking(pendingCancelBookingId);
  closeModal('cancelConfirmModal');
  
  if (res.success) {
    showToast(`Booking cancelled successfully! Parking Slot ${res.slotId} is now available.`, 'success', 4000);
    if (res.refundAmount > 0) {
      setTimeout(() => {
        showToast(`Your refund of ₹${res.refundAmount} has been credited to your Wallet.`, 'info', 4000);
      }, 800);
    }
    renderMyBookingsUI();
  } else {
    showToast(res.error, 'error');
  }
  pendingCancelBookingId = null;
}

let currentBookingsFilter = 'all';

function setBookingsFilter(filter, btnEl) {
  currentBookingsFilter = filter;
  document.querySelectorAll('.booking-filter-tab').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderMyBookingsUI(filter);
}

function renderMyBookingsUI(filter = currentBookingsFilter) {
  const container = document.getElementById('myBookingsListContainer');
  if (!container) return;

  const user = getCurrentUser();
  if (!user) {
    container.innerHTML = `
      <div style="text-align:center; padding:30px; color:var(--text-muted);">
        <p>Please log in to view your bookings history.</p>
        <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="closeModal('myBookingsModal'); openAuthModal();">Login Now</button>
      </div>
    `;
    return;
  }

  let userBookings = bookings.filter(b => b.userId === user.id || b.driverName === user.name);

  if (filter !== 'all') {
    userBookings = userBookings.filter(b => {
      const status = (b.bookingStatus || b.status || 'CONFIRMED').toUpperCase();
      return status === filter.toUpperCase();
    });
  }

  if (userBookings.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px; color:var(--text-muted); background:var(--bg-secondary); border-radius:var(--radius-md);">
        <div style="font-size:2rem; margin-bottom:8px;">🚗</div>
        <p>No ${filter !== 'all' ? filter : ''} bookings found.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = userBookings.map(b => {
    const isCancelled = (b.bookingStatus === 'CANCELLED' || b.status === 'CANCELLED');
    const isExpired = (b.bookingStatus === 'EXPIRED' || b.status === 'EXPIRED');
    const isConfirmed = (!b.bookingStatus || b.bookingStatus === 'CONFIRMED') && !isCancelled && !isExpired;

    let statusBadge = `<span class="badge badge-green">● Confirmed</span>`;
    if (isCancelled) statusBadge = `<span class="badge badge-red">● Cancelled</span>`;
    else if (isExpired) statusBadge = `<span class="badge badge-yellow">● Expired</span>`;

    const refundBadge = b.refundAmount > 0
      ? `<div style="font-size:0.75rem; color:var(--green-light); margin-top:4px;">Refund: ₹${b.refundAmount} (${b.refundStatus || 'Refunded'})</div>`
      : '';

    const endTimeFormatted = new Date(b.endTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const startTimeFormatted = new Date(b.entryTime || b.startTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

    return `
      <div class="card" style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; margin-bottom:12px;">
        <div class="flex-between" style="margin-bottom:8px;">
          <div>
            <strong style="font-family:monospace; color:var(--accent-light); font-size:1rem;">${b.id}</strong>
            <span class="badge badge-purple" style="margin-left:8px;">Slot ${b.slotId}</span>
          </div>
          ${statusBadge}
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.82rem; color:var(--text-secondary); margin-bottom:12px;">
          <div><strong>Date:</strong> ${new Date(b.entryTime).toLocaleDateString('en-IN')}</div>
          <div><strong>Window:</strong> ${startTimeFormatted} - ${endTimeFormatted}</div>
          <div><strong>Amount:</strong> <span style="color:var(--green-light); font-weight:bold;">₹${b.amount}</span></div>
          <div><strong>Vehicle:</strong> ${b.vehicleNo}</div>
          ${isCancelled && b.cancelledAt ? `<div style="grid-column:1/-1; color:var(--red-light);"><strong>Cancelled At:</strong> ${new Date(b.cancelledAt).toLocaleString('en-IN')}</div>` : ''}
          ${refundBadge ? `<div style="grid-column:1/-1;">${refundBadge}</div>` : ''}
        </div>

        <div class="flex gap-8" style="justify-content:flex-end; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick='exportBookingReceiptPDF(${JSON.stringify(b)})'>
            📥 PDF
          </button>
          ${isConfirmed ? `
            <button class="btn btn-warning btn-sm" style="background:rgba(245,158,11,0.15); border-color:var(--yellow); color:var(--yellow); font-weight:600;" onclick="closeModal('myBookingsModal'); promptExtendBooking('${b.id}')">
              ⏳ Extend
            </button>
            <button class="btn btn-danger btn-sm" onclick="promptCancelBooking('${b.id}')">
              🚫 Cancel
            </button>
            <button class="btn btn-ghost btn-sm" style="font-size:0.75rem; color:var(--accent-light);" onclick="simulateBookingExpiry('${b.id}')" title="Test 15-Minute Expiry Reminder Alert">
              ⚡ Test 15m Alert
            </button>
          ` : `
            <button class="btn btn-ghost btn-sm" disabled style="opacity:0.5; cursor:not-allowed;">
              ${isCancelled ? 'Cancelled' : 'Expired'}
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

function openMyBookingsModal() {
  renderMyBookingsUI('all');
  openModal('myBookingsModal');
}

// ─── INJECT MODALS INTO BODY ──────────────────
function injectGlobalModals() {
  if (document.getElementById('authModal')) return;

  const modalWrapper = document.createElement('div');
  modalWrapper.innerHTML = `
    <!-- AUTH MODAL -->
    <div class="modal-overlay" id="authModal" style="display:none;">
      <div class="modal-box">
        <div class="modal-header">
          <h3 class="modal-title">🔐 User Account & Role</h3>
          <button class="modal-close" onclick="closeModal('authModal')">✕</button>
        </div>
        <div id="authModalBody">
          <div style="text-align:center; margin-bottom:24px;">
            <div style="font-size:3rem; margin-bottom:8px;">🅿️</div>
            <h4>Switch Demo Account or Login</h4>
            <p style="color:var(--text-secondary); font-size:0.85rem;">Select a role to test specific user capabilities</p>
          </div>

          <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:24px;">
            <button class="btn btn-ghost" style="justify-content:flex-start;" onclick="quickLogin('driver')">
              <span style="font-size:1.5rem;">👨‍💼</span>
              <div style="text-align:left;">
                <div style="font-weight:700;">Alex Rivera (Standard Driver)</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">Wallet Balance: ₹850 • SUV KA 01 AB 4321</div>
              </div>
            </button>

            <button class="btn btn-ghost" style="justify-content:flex-start;" onclick="quickLogin('vip')">
              <span style="font-size:1.5rem;">⭐</span>
              <div style="text-align:left;">
                <div style="font-weight:700;">Sophia Chen (VIP Pass Holder)</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">Wallet Balance: ₹2,500 • EV Charging Discount</div>
              </div>
            </button>

            <button class="btn btn-ghost" style="justify-content:flex-start;" onclick="quickLogin('admin')">
              <span style="font-size:1.5rem;">🛡️</span>
              <div style="text-align:left;">
                <div style="font-weight:700;">Security Operator (Admin)</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">Full Barrier Gate, Cancellation & Sensor Access</div>
              </div>
            </button>
          </div>

          <div class="divider"></div>

          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.85rem; color:var(--text-muted);" id="currentLoggedInfo">Logged in as: Alex Rivera</span>
            <button class="btn btn-danger btn-sm" onclick="logoutUser(); closeModal('authModal');">Logout</button>
          </div>
        </div>
      </div>
    </div>

    <!-- WALLET TOPUP MODAL -->
    <div class="modal-overlay" id="walletModal" style="display:none;">
      <div class="modal-box">
        <div class="modal-header">
          <h3 class="modal-title">👛 SmartPark Wallet Top-Up</h3>
          <button class="modal-close" onclick="closeModal('walletModal')">✕</button>
        </div>
        <div>
          <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:20px; text-align:center; margin-bottom:20px;">
            <div style="font-size:0.8rem; color:var(--text-secondary);">AVAILABLE WALLET BALANCE</div>
            <div style="font-size:2.4rem; font-weight:800; color:var(--green-light); font-family:'Outfit',sans-serif;" id="walletModalBalance">₹0</div>
          </div>

          <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">Select Quick Amount to Add:</p>
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;">
            <button class="btn btn-ghost" onclick="topUpWallet(200); updateWalletModalUI();">+ ₹200</button>
            <button class="btn btn-ghost" onclick="topUpWallet(500); updateWalletModalUI();">+ ₹500</button>
            <button class="btn btn-ghost" onclick="topUpWallet(1000); updateWalletModalUI();">+ ₹1,000</button>
          </div>

          <div class="divider"></div>
          <button class="btn btn-primary" style="width:100%; justify-content:center;" onclick="closeModal('walletModal')">Done</button>
        </div>
      </div>
    </div>

    <!-- NOTIFICATIONS MODAL -->
    <div class="modal-overlay" id="notificationsModal" style="display:none; z-index:2800;">
      <div class="modal-box" style="max-width:550px;">
        <div class="modal-header">
          <div class="flex gap-8" style="align-items:center;">
            <h3 class="modal-title">🔔 Notifications & Reminders</h3>
          </div>
          <button class="modal-close" onclick="closeModal('notificationsModal')">✕</button>
        </div>
        
        <div class="flex-between" style="margin-bottom:14px; background:var(--bg-secondary); padding:10px 14px; border-radius:var(--radius-md); border:1px solid var(--border);">
          <span style="font-size:0.8rem; color:var(--text-secondary);">Background Browser Alerts</span>
          <button class="btn btn-ghost btn-sm" style="font-size:0.75rem;" onclick="requestBrowserNotificationPermission()">
            🔔 Enable Push Alerts
          </button>
        </div>

        <div id="notificationsListContainer" style="max-height:420px; overflow-y:auto; margin-bottom:14px;">
          <!-- Dynamically populated -->
        </div>

        <div class="flex-between">
          <button class="btn btn-ghost btn-sm" onclick="clearAllNotifications()">Clear All</button>
          <button class="btn btn-primary btn-sm" onclick="closeModal('notificationsModal')">Close</button>
        </div>
      </div>
    </div>

    <!-- EXTEND PARKING MODAL -->
    <div class="modal-overlay" id="extendParkingModal" style="display:none; z-index:3000;">
      <div class="modal-box" style="max-width:500px;">
        <div class="modal-header">
          <h3 class="modal-title" style="color:var(--yellow);">⏳ Extend Parking Reservation</h3>
          <button class="modal-close" onclick="closeModal('extendParkingModal')">✕</button>
        </div>
        
        <div>
          <!-- Current Slot Info Box -->
          <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; font-size:0.88rem; margin-bottom:16px;">
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Parking Slot:</span>
              <strong style="color:var(--accent-light);" id="extSlotDisplay">P-05</strong>
            </div>
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Booking Ref:</span>
              <strong style="font-family:monospace;" id="extBookingIdDisplay">BK-1001</strong>
            </div>
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Driver & Vehicle:</span>
              <strong id="extDriverDisplay">Alex Rivera</strong>
            </div>
            <div class="flex-between">
              <span style="color:var(--text-secondary);">Current End Time:</span>
              <strong style="color:var(--yellow);" id="extCurrentEndDisplay">12:00 PM</strong>
            </div>
          </div>

          <!-- Extension Duration Selection -->
          <label style="font-size:0.85rem; font-weight:600; color:var(--text-secondary); margin-bottom:8px; display:block;">Select Extension Time:</label>
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:16px;">
            <div class="ext-option-card selected" data-mins="30" onclick="selectExtendOption(30, this)">
              <div>
                <div style="font-weight:700; font-size:0.95rem;">+ 30 Mins</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">Quick Buffer</div>
              </div>
              <span style="font-weight:700; color:var(--green-light);" id="extCost30m">+ ₹10</span>
            </div>

            <div class="ext-option-card" data-mins="60" onclick="selectExtendOption(60, this)">
              <div>
                <div style="font-weight:700; font-size:0.95rem;">+ 1 Hour</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">Standard</div>
              </div>
              <span style="font-weight:700; color:var(--green-light);" id="extCost1h">+ ₹20</span>
            </div>

            <div class="ext-option-card" data-mins="120" onclick="selectExtendOption(120, this)">
              <div>
                <div style="font-weight:700; font-size:0.95rem;">+ 2 Hours</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">Extended</div>
              </div>
              <span style="font-weight:700; color:var(--green-light);" id="extCost2h">+ ₹40</span>
            </div>
          </div>

          <!-- Conflict Warning Alert (if any) -->
          <div id="extConflictAlert" style="display:none; background:rgba(239,68,68,0.1); border:1px solid var(--red); color:var(--red-light); padding:10px 14px; border-radius:var(--radius-md); font-size:0.82rem; margin-bottom:14px;">
            ⚠️ Another reservation exists after current end time.
          </div>

          <!-- Extended End Time & Payable Preview -->
          <div style="background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:var(--radius-md); padding:14px; margin-bottom:16px;">
            <div class="flex-between" style="margin-bottom:6px;">
              <span style="font-size:0.85rem; color:var(--text-secondary);">New Expiry Time:</span>
              <strong style="color:var(--green-light); font-size:1.1rem;" id="extNewEndDisplay">12:30 PM</strong>
            </div>
            <div class="flex-between">
              <span style="font-size:0.85rem; color:var(--text-secondary);">Extension Charge:</span>
              <strong style="color:var(--accent-light); font-size:1.1rem;" id="extTotalAmountDisplay">₹10</strong>
            </div>
          </div>

          <!-- Payment Options for Extension -->
          <label style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:6px; display:block;">Pay Extension Via:</label>
          <div style="display:flex; gap:16px; margin-bottom:18px; font-size:0.85rem;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="radio" name="extPayMethod" value="WALLET" checked />
              👛 Wallet
            </label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="radio" name="extPayMethod" value="UPI" />
              📱 UPI / QR
            </label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="radio" name="extPayMethod" value="CARD" />
              💳 Card
            </label>
          </div>

          <div class="flex gap-12">
            <button class="btn btn-warning" id="extConfirmBtn" style="flex:1; justify-content:center; background:var(--yellow); color:#000; font-weight:700;" onclick="confirmExtendBooking()">
              Confirm Extension
            </button>
            <button class="btn btn-ghost" style="flex:1; justify-content:center;" onclick="closeModal('extendParkingModal')">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- MY BOOKINGS MODAL -->
    <div class="modal-overlay" id="myBookingsModal" style="display:none;">
      <div class="modal-box" style="max-width:650px;">
        <div class="modal-header">
          <h3 class="modal-title">📋 My Bookings History</h3>
          <button class="modal-close" onclick="closeModal('myBookingsModal')">✕</button>
        </div>
        
        <!-- Filter Tabs -->
        <div class="flex gap-8" style="margin-bottom:16px; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm booking-filter-tab active" onclick="setBookingsFilter('all', this)">All</button>
          <button class="btn btn-ghost btn-sm booking-filter-tab" onclick="setBookingsFilter('CONFIRMED', this)">Confirmed</button>
          <button class="btn btn-ghost btn-sm booking-filter-tab" onclick="setBookingsFilter('CANCELLED', this)">Cancelled</button>
          <button class="btn btn-ghost btn-sm booking-filter-tab" onclick="setBookingsFilter('COMPLETED', this)">Completed</button>
          <button class="btn btn-ghost btn-sm booking-filter-tab" onclick="setBookingsFilter('EXPIRED', this)">Expired</button>
        </div>

        <div id="myBookingsListContainer" style="max-height:450px; overflow-y:auto;">
          <!-- Rendered dynamically -->
        </div>
      </div>
    </div>

    <!-- CANCEL CONFIRMATION POPUP MODAL -->
    <div class="modal-overlay" id="cancelConfirmModal" style="display:none; z-index:3000;">
      <div class="modal-box" style="max-width:480px;">
        <div class="modal-header">
          <h3 class="modal-title" style="color:var(--red-light);">⚠️ Cancel Parking Booking</h3>
          <button class="modal-close" onclick="closeModal('cancelConfirmModal')">✕</button>
        </div>
        
        <div>
          <p style="font-size:0.95rem; margin-bottom:16px; color:var(--text-primary);">
            Are you sure you want to cancel this parking booking?
          </p>

          <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; font-size:0.88rem; margin-bottom:16px;">
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Parking Slot:</span>
              <strong style="color:var(--accent-light);" id="cancelSlotDisplay">P-05</strong>
            </div>
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Date:</span>
              <strong id="cancelDateDisplay">05 October 2026</strong>
            </div>
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Scheduled Entry:</span>
              <strong id="cancelTimeDisplay">10:00 AM</strong>
            </div>
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="color:var(--text-secondary);">Booking Amount:</span>
              <strong id="cancelAmountDisplay">₹50</strong>
            </div>
            <div class="divider"></div>
            <div class="flex-between">
              <span style="color:var(--green-light); font-weight:bold;">Estimated Refund (50%):</span>
              <strong style="color:var(--green-light);" id="cancelRefundDisplay">₹25 (50%)</strong>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;" id="cancelPolicyNote">
              50% refund applied to your SmartPark wallet balance upon cancellation.
            </div>
          </div>

          <div class="flex gap-12">
            <button class="btn btn-danger" id="cancelConfirmBtn" style="flex:1; justify-content:center;" onclick="confirmCancelBooking()">
              Yes, Cancel Booking
            </button>
            <button class="btn btn-ghost" style="flex:1; justify-content:center;" onclick="closeModal('cancelConfirmModal')">
              No, Keep Booking
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- GATE TERMINAL SCANNER MODAL -->
    <div class="modal-overlay" id="gateTerminalModal" style="display:none; z-index:3200;">
      <div class="modal-box" style="max-width:540px;">
        <div class="modal-header">
          <div class="flex gap-8" style="align-items:center;">
            <h3 class="modal-title">📷 Gate Terminal Scanner & Sensor Sim</h3>
          </div>
          <button class="modal-close" onclick="closeModal('gateTerminalModal')">✕</button>
        </div>

        <div>
          <div class="flex-between" style="margin-bottom:12px;">
            <span style="font-size:0.85rem; color:var(--text-secondary);" id="gateTerminalTypeDisplay">Barrier Gate 01 (Entry)</span>
            <input type="hidden" id="gateTerminalTarget" value="entry" />
            <button class="btn btn-ghost btn-sm" onclick="openEsp32FirmwareModal()">📟 ESP32 Code</button>
          </div>

          <div class="scanner-terminal-box" style="margin-bottom:16px;">
            <div style="font-size:2rem; margin-bottom:8px;">📷 📡</div>
            <div style="font-size:0.9rem; font-weight:700; color:var(--accent-light); margin-bottom:4px;">SCAN BOOKING QR CODE / TAP RFID TAG</div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px;">ESP32 Optical Serial Reader / MFRC522 Scanner Simulation</div>
            
            <div class="input-group" style="display:flex; gap:8px;">
              <input type="text" id="gateTerminalManualInput" placeholder="Enter Booking ID (e.g. BK-1001) or Plate" style="padding:10px 14px; font-size:0.9rem; font-family:monospace;" />
              <button class="btn btn-primary btn-sm" onclick="processGateScan(document.getElementById('gateTerminalTarget').value, document.getElementById('gateTerminalManualInput').value)">
                Scan
              </button>
            </div>
          </div>

          <!-- Quick Booking Test Buttons -->
          <div style="margin-bottom:16px;">
            <div style="font-size:0.8rem; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">Quick Test with Recent Bookings:</div>
            <div id="gateTerminalQuickList" style="display:flex; flex-direction:column; gap:4px; max-height:160px; overflow-y:auto;">
              <!-- Filled dynamically -->
            </div>
          </div>

          <!-- Under-Barrier Safety Sensor Simulation Controls -->
          <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:12px; margin-bottom:16px;">
            <div class="flex-between" style="margin-bottom:8px;">
              <span style="font-size:0.82rem; font-weight:700;">IR / Ultrasonic Under-Barrier Sensor:</span>
              <span class="badge badge-green" id="terminalSafetyBadge">BEAM CLEAR</span>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-warning btn-sm" style="flex:1; justify-content:center; font-size:0.78rem;" onclick="setUnderBarrierSensor(document.getElementById('gateTerminalTarget').value, true)">
                🚗 Simulate Vehicle Under Barrier (Hold Open)
              </button>
              <button class="btn btn-success btn-sm" style="flex:1; justify-content:center; font-size:0.78rem;" onclick="setUnderBarrierSensor(document.getElementById('gateTerminalTarget').value, false)">
                ✅ Vehicle Clears Barrier
              </button>
            </div>
          </div>

          <div class="flex gap-8" style="justify-content:flex-end;">
            <button class="btn btn-primary btn-sm" onclick="closeModal('gateTerminalModal')">Done</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ESP32 ARDUINO FIRMWARE & WIRING MODAL -->
    <div class="modal-overlay" id="esp32FirmwareModal" style="display:none; z-index:3400;">
      <div class="modal-box" style="max-width:700px;">
        <div class="modal-header">
          <h3 class="modal-title">📟 ESP32 & Arduino Gate Controller Hardware Sketch</h3>
          <button class="modal-close" onclick="closeModal('esp32FirmwareModal')">✕</button>
        </div>

        <div>
          <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:12px; font-size:0.82rem; margin-bottom:14px;">
            <div><strong>Hardware Bill of Materials:</strong></div>
            <div style="color:var(--text-secondary); margin-top:4px;">
              • ESP32 NodeMCU DevKit V1 • MG995 / SG90 Servo (PWM Pin 18)<br/>
              • HC-SR04 Ultrasonic Sensor (Trig Pin 5, Echo Pin 19) • IR Obstacle Sensor (Pin 21)<br/>
              • MFRC522 RFID SPI Module (SS Pin 15, RST Pin 2) • Status LEDs (Red 16, Yellow 4, Green 17)<br/>
              • Piezo Buzzer (Pin 22) • REST API Sync over Wi-Fi
            </div>
          </div>

          <div style="background:#020617; border:1px solid var(--border); border-radius:var(--radius-md); padding:14px; font-family:monospace; font-size:0.75rem; color:#38bdf8; max-height:300px; overflow-y:auto; line-height:1.4; margin-bottom:16px;">
            // Download full sketch from workspace: esp32_gate_firmware.ino<br/>
            #include &lt;WiFi.h&gt;<br/>
            #include &lt;HTTPClient.h&gt;<br/>
            #include &lt;ESP32Servo.h&gt;<br/>
            #include &lt;MFRC522.h&gt;<br/><br/>
            #define PIN_SERVO 18<br/>
            #define PIN_TRIG 5<br/>
            #define PIN_ECHO 19<br/>
            #define PIN_IR_SAFETY 21<br/>
            #define PIN_LED_RED 16<br/>
            #define PIN_LED_GREEN 17<br/>
            #define PIN_BUZZER 22<br/><br/>
            void openBarrierGate() {<br/>
            &nbsp;&nbsp;for (int pos = 0; pos &lt;= 90; pos += 2) { barrierServo.write(pos); delay(15); }<br/>
            }<br/><br/>
            void closeBarrierGate() {<br/>
            &nbsp;&nbsp;if (isVehicleUnderBarrier()) return; // Safety Hold<br/>
            &nbsp;&nbsp;for (int pos = 90; pos &gt;= 0; pos -= 2) { barrierServo.write(pos); delay(15); }<br/>
            }
          </div>

          <div class="flex-between">
            <span style="font-size:0.75rem; color:var(--text-muted);">Source file: <code>esp32_gate_firmware.ino</code></span>
            <button class="btn btn-primary btn-sm" onclick="closeModal('esp32FirmwareModal')">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalWrapper);
}

function openAuthModal() {
  const user = getCurrentUser();
  const infoEl = document.getElementById('currentLoggedInfo');
  if (infoEl) {
    infoEl.textContent = user ? `Logged in as: ${user.name}` : 'Not logged in';
  }
  openModal('authModal');
}

function openWalletModal() {
  updateWalletModalUI();
  openModal('walletModal');
}

function updateWalletModalUI() {
  const user = getCurrentUser();
  const balEl = document.getElementById('walletModalBalance');
  if (balEl && user) {
    balEl.textContent = formatCurrency(user.walletBalance || 0);
  }
}

function quickLogin(role) {
  let user;
  if (role === 'vip') {
    user = {
      id: 'USR-VIP99',
      name: 'Sophia Chen',
      email: 'sophia.chen@vip.smartpark.io',
      role: 'vip',
      walletBalance: 2500,
      avatar: '⭐',
      plate: 'KA 05 EV 9999'
    };
  } else if (role === 'admin') {
    user = {
      id: 'ADM-001',
      name: 'Security Chief',
      email: 'admin@smartpark.io',
      role: 'admin',
      walletBalance: 5000,
      avatar: '🛡️',
      plate: 'GOVT 01 0001'
    };
  } else {
    user = {
      id: 'USR-7092',
      name: 'Alex Rivera',
      email: 'alex.rivera@smartpark.io',
      role: 'driver',
      walletBalance: 850,
      avatar: '👨‍💼',
      plate: 'KA 01 AB 4321'
    };
  }
  loginUser(user);
  closeModal('authModal');
}

// ─── STATS COUNTER ANIMATION ──────────────────
function animateCounter(el, target, prefix = '', suffix = '', duration = 1200) {
  if (!el) return;
  const step = (timestamp) => {
    if (!el._startTime) el._startTime = timestamp;
    const progress = Math.min((timestamp - el._startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = prefix + Math.floor(eased * target) + suffix;
    if (progress < 1) requestAnimationFrame(step);
    else el._startTime = null;
  };
  requestAnimationFrame(step);
}

// ─── INTERSECTION OBSERVER FOR ANIMATIONS ─────
function initScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.animate-fade-up').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });
}

// ─── ACTIVE NAV LINK ──────────────────────────
function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initScrollAnimations();
  setActiveNav();
  injectGlobalModals();
  updateUserNavUI();
  updateNotificationNavBadge();
  startIotSim();
  startExpiryReminderScheduler();
});



