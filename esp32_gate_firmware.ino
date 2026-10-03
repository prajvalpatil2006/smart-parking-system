/*
 * ======================================================================================
 * SmartPark IoT – ESP32 / Arduino Automated Barrier Gate Controller Firmware
 * ======================================================================================
 * Hardware Components:
 *  - ESP32 NodeMCU / Arduino Uno / Mega
 *  - SG90 / MG995 / MG996R Servo Motor (Gate Barrier Arm)
 *  - HC-SR04 Ultrasonic Sensor or Obstacle IR Sensor (Under-Barrier Safety Vehicle Detection)
 *  - MFRC522 RFID Reader / GM67 Barcode QR Serial Scanner
 *  - RGB / Dual Status LEDs (Red = Closed, Green = Open, Yellow = Motion)
 *  - Active/Passive Piezo Buzzer (Audio Feedback)
 *  - WiFi & HTTP Client (Sync with SmartPark REST API: /api/v1/gates/*)
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <MFRC522.h>

// ─── PIN DEFINITIONS ─────────────────────────────────
#define PIN_SERVO           18   // PWM pin for Barrier Servo Motor
#define PIN_TRIG            5    // Ultrasonic Trigger Pin
#define PIN_ECHO            19   // Ultrasonic Echo Pin
#define PIN_IR_SAFETY       21   // IR Obstacle Sensor (Under-Barrier Safety)
#define PIN_LED_RED         16   // Gate Closed LED
#define PIN_LED_GREEN       17   // Gate Open / Verified LED
#define PIN_LED_YELLOW      4    // Gate In-Motion / Busy LED
#define PIN_BUZZER          22   // Piezo Buzzer Pin

// RFID Pins (SPI)
#define PIN_RFID_SS         15
#define PIN_RFID_RST        2

// ─── CONFIGURATION CONSTANTS ─────────────────────────
const char* WIFI_SSID       = "SmartPark_IoT_Network";
const char* WIFI_PASS       = "SmartParkSecret2026";
const char* API_BASE_URL    = "http://192.168.1.100:8080/api/v1";

const int SERVO_POS_CLOSED  = 0;    // 0 Degrees (Barrier Down / Closed)
const int SERVO_POS_OPEN    = 90;   // 90 Degrees (Barrier Up / Open)
const int SAFETY_DIST_CM    = 60;   // Ultrasonic detection threshold under barrier (cm)
const unsigned long CLEAR_WAIT_MS = 2500; // Wait 2.5s after vehicle clears before closing

// ─── GATE ENUM STATES ────────────────────────────────
enum GateState {
  STATE_CLOSED,
  STATE_OPENING,
  STATE_OPEN,
  STATE_CLOSING
};

GateState currentGateState = STATE_CLOSED;
Servo barrierServo;
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);

unsigned long vehicleClearedTime = 0;
bool vehicleUnderBarrier = false;

// ─── BUZZER TONES ────────────────────────────────────
void soundBuzzerSuccess() {
  tone(PIN_BUZZER, 1200, 100);
  delay(120);
  tone(PIN_BUZZER, 1800, 150);
}

void soundBuzzerDenied() {
  tone(PIN_BUZZER, 300, 200);
  delay(100);
  tone(PIN_BUZZER, 250, 300);
}

void soundBuzzerWarning() {
  tone(PIN_BUZZER, 800, 80);
}

// ─── LED INDICATORS ──────────────────────────────────
void setLeds(bool red, bool yellow, bool green) {
  digitalWrite(PIN_LED_RED, red ? HIGH : LOW);
  digitalWrite(PIN_LED_YELLOW, yellow ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, green ? HIGH : LOW);
}

// ─── SENSOR READING ──────────────────────────────────
long readUltrasonicDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  
  long duration = pulseIn(PIN_ECHO, HIGH, 30000); // 30ms timeout
  if (duration == 0) return 200; // No obstacle within range
  return duration * 0.034 / 2;
}

bool isVehicleUnderBarrier() {
  // Check both IR sensor (active LOW) and Ultrasonic distance
  bool irDetected = (digitalRead(PIN_IR_SAFETY) == LOW);
  long dist = readUltrasonicDistanceCm();
  bool ultrasonicDetected = (dist > 0 && dist < SAFETY_DIST_CM);
  
  return irDetected || ultrasonicDetected;
}

// ─── GATE MOVEMENT ROUTINES ──────────────────────────
void openBarrierGate() {
  if (currentGateState == STATE_OPEN || currentGateState == STATE_OPENING) return;
  
  Serial.println("[GATE] Opening barrier arm to 90 degrees...");
  currentGateState = STATE_OPENING;
  setLeds(false, true, false); // Yellow LED on
  
  // Smooth servo rotation from 0 to 90
  for (int pos = SERVO_POS_CLOSED; pos <= SERVO_POS_OPEN; pos += 2) {
    barrierServo.write(pos);
    delay(15);
  }
  
  currentGateState = STATE_OPEN;
  setLeds(false, false, true); // Green LED on
  Serial.println("[GATE] Barrier is now OPEN.");
  
  // Sync state with cloud API
  syncGateStateToCloud("OPEN");
}

void closeBarrierGate() {
  // SAFETY GUARD: Do NOT close if vehicle is detected underneath!
  if (isVehicleUnderBarrier()) {
    Serial.println("[SAFETY ALERT] Vehicle still detected underneath barrier! Holding gate OPEN.");
    soundBuzzerWarning();
    return;
  }
  
  if (currentGateState == STATE_CLOSED || currentGateState == STATE_CLOSING) return;
  
  Serial.println("[GATE] Vehicle cleared. Closing barrier arm to 0 degrees...");
  currentGateState = STATE_CLOSING;
  setLeds(false, true, false); // Yellow LED on
  
  // Smooth servo rotation from 90 to 0
  for (int pos = SERVO_POS_OPEN; pos >= SERVO_POS_CLOSED; pos -= 2) {
    // Re-check safety during closing
    if (isVehicleUnderBarrier()) {
      Serial.println("[SAFETY INTERRUPT] Obstacle detected during closing! Re-opening immediately.");
      openBarrierGate();
      return;
    }
    barrierServo.write(pos);
    delay(15);
  }
  
  currentGateState = STATE_CLOSED;
  setLeds(true, false, false); // Red LED on
  Serial.println("[GATE] Barrier is now CLOSED.");
  
  // Sync state with cloud API
  syncGateStateToCloud("CLOSED");
}

// ─── VERIFY QR / RFID BOOKING VIA REST API ───────────
bool verifyBookingWithServer(String credential) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Offline. Running offline fallback verification.");
    return credential.startsWith("BK-") || credential.startsWith("RFID-");
  }

  HTTPClient http;
  String url = String(API_BASE_URL) + "/gates/verify?code=" + credential;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.GET();
  bool verified = false;

  if (httpCode == 200) {
    String payload = http.getString();
    Serial.println("[API RESPONSE] " + payload);
    // Parse JSON verification status
    if (payload.indexOf("\"valid\":true") >= 0 || payload.indexOf("\"CONFIRMED\"") >= 0) {
      verified = true;
    }
  } else {
    Serial.printf("[API ERROR] HTTP Code: %d\n", httpCode);
  }
  http.end();
  return verified;
}

void syncGateStateToCloud(String state) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(API_BASE_URL) + "/gates/entry/state";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.POST("{\"state\":\"" + state + "\",\"timestamp\":" + String(millis()) + "}");
  http.end();
}

// ─── SETUP ───────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n==========================================");
  Serial.println("  SmartPark IoT Automatic Gate Controller ");
  Serial.println("==========================================");

  // Pin Modes
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_IR_SAFETY, INPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  // Servo Initialization
  barrierServo.attach(PIN_SERVO);
  barrierServo.write(SERVO_POS_CLOSED);
  setLeds(true, false, false); // Closed (Red)

  // SPI & RFID
  SPI.begin();
  rfid.PCD_Init();

  // Connect to WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WIFI] Connecting");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 10) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WIFI] Running in standalone IoT mode.");
  }
}

// ─── MAIN LOOP ───────────────────────────────────────
void loop() {
  // 1. Read RFID Card if Present
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String rfidUid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      rfidUid += String(rfid.uid.uidByte[i] < 0x10 ? "0" : "");
      rfidUid += String(rfid.uid.uidByte[i], HEX);
    }
    rfidUid.toUpperCase();
    Serial.println("\n[RFID DETECTED] Tag UID: " + rfidUid);

    bool isValid = verifyBookingWithServer("RFID-" + rfidUid);
    if (isValid) {
      Serial.println("[ACCESS GRANTED] Active booking confirmed!");
      soundBuzzerSuccess();
      openBarrierGate();
    } else {
      Serial.println("[ACCESS DENIED] Invalid or cancelled booking.");
      soundBuzzerDenied();
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  // 2. Read Serial Barcode / QR Scanner Input
  if (Serial.available() > 0) {
    String scannedQr = Serial.readStringUntil('\n');
    scannedQr.trim();
    if (scannedQr.length() > 0) {
      Serial.println("\n[QR SCANNED] Received Payload: " + scannedQr);
      bool isValid = verifyBookingWithServer(scannedQr);
      if (isValid) {
        Serial.println("[ACCESS GRANTED] QR Code Verified!");
        soundBuzzerSuccess();
        openBarrierGate();
      } else {
        Serial.println("[ACCESS DENIED] Booking cancelled or not found.");
        soundBuzzerDenied();
      }
    }
  }

  // 3. Automated Safety Gate Closing Logic
  if (currentGateState == STATE_OPEN) {
    bool detectedNow = isVehicleUnderBarrier();

    if (detectedNow) {
      vehicleUnderBarrier = true;
      vehicleClearedTime = 0; // Reset clear timer
      Serial.println("[SENSOR] Vehicle passing underneath barrier... holding OPEN.");
    } else {
      // Vehicle was underneath, now cleared
      if (vehicleUnderBarrier) {
        if (vehicleClearedTime == 0) {
          vehicleClearedTime = millis();
          Serial.println("[SENSOR] Vehicle cleared barrier! Starting 2.5s countdown to close...");
        } else if (millis() - vehicleClearedTime >= CLEAR_WAIT_MS) {
          // Safe to close after clear duration
          vehicleUnderBarrier = false;
          vehicleClearedTime = 0;
          closeBarrierGate();
        }
      }
    }
  }

  delay(50);
}
