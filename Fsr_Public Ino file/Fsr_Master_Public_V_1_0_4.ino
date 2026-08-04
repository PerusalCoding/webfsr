#include <inttypes.h>
#include <EEPROM.h>
#include <FastLED.h>

#if !defined(__AVR_ATmega32U4__) && !defined(__AVR_ATmega328P__) && \
    !defined(__AVR_ATmega1280__) && !defined(__AVR_ATmega2560__)
  #define CAN_AVERAGE
#endif

#if defined(_SFR_BYTE) && defined(_BV) && defined(ADCSRA)
  #define CLEAR_BIT(sfr, bit) (_SFR_BYTE(sfr) &= ~_BV(bit))
  #define SET_BIT(sfr, bit) (_SFR_BYTE(sfr) |= _BV(bit))
#endif

// #define USE_ARDUINO_JOYSTICK_LIBRARY

#if defined(CORE_TEENSY)
  void ButtonStart() {
    #ifndef __AVR_ATmega32U4__
      Joystick.begin();
    #endif
    Joystick.useManualSend(true);
  }
  void ButtonPress(uint8_t button_num) { Joystick.button(button_num, 1); }
  void ButtonRelease(uint8_t button_num) { Joystick.button(button_num, 0); }
  bool ButtonSend() { Joystick.send_now(); return true; }
  // Reports this board's factory-unique chip ID over serial (as part of
  // the 'i' identify command below) so WebFsr can tell physically
  // distinct pads apart when more than one is connected to the same
  // computer -- without this, two pads' saved Advanced Tuning/profile
  // data would silently clobber each other in the dashboard, since it
  // had no way to distinguish which pad it was actually talking to.
  // Only Teensy 4.x (IMXRT1062) actually has the HW_OCOTP_CFG0/CFG1
  // fused-in-silicon unique ID registers this relies on -- Teensy 3.x
  // doesn't expose an equivalent, so this deliberately prints nothing
  // at all there (not even a blank field), which the dashboard already
  // treats identically to "older firmware with no chip ID support".
  void PrintUniqueChipIdIfAvailable() {
    #if defined(__IMXRT1062__)
      uint32_t hi = HW_OCOTP_CFG1;
      uint32_t lo = HW_OCOTP_CFG0;
      char buf[17];
      snprintf(buf, sizeof(buf), "%08lX%08lX", (unsigned long)hi, (unsigned long)lo);
      Serial.print(" ");
      Serial.print(buf);
    #endif
  }
#elif defined(ARDUINO_ARCH_RP2040) || defined(PICO_BOARD)
  #include <Joystick.h>
  #include "tusb.h"
  #include "pico/unique_id.h"
  int usb_hid_poll_interval = 1;
  void ButtonStart() { Joystick.begin(); Joystick.useManualSend(true); }
  void ButtonPress(uint8_t button_num) { Joystick.button(button_num, 1); }
  void ButtonRelease(uint8_t button_num) { Joystick.button(button_num, 0); }
  bool ButtonSend() {
    if (!tud_hid_ready()) return false;
    Joystick.send_now(); return true;
  }
  // RP2040's flash chip has its own factory-unique 64-bit ID, exposed via
  // the Pico SDK's pico_get_unique_board_id() -- see the matching Teensy
  // comment above for why this field exists at all.
  void PrintUniqueChipIdIfAvailable() {
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    char buf[17];
    for (int i = 0; i < 8; i++) snprintf(buf + (i * 2), 3, "%02X", id.id[i]);
    Serial.print(" ");
    Serial.print(buf);
  }
#elif defined(USE_ARDUINO_JOYSTICK_LIBRARY)
  #include <Joystick.h>
  Joystick_ Joystick;
  void ButtonStart() { Joystick.begin(false); }
  void ButtonPress(uint8_t button_num) { Joystick.pressButton(button_num); }
  void ButtonRelease(uint8_t button_num) { Joystick.releaseButton(button_num); }
  bool ButtonSend() { Joystick.sendState(); return true; }
  // No reliable factory-unique hardware ID available on this target --
  // deliberately a no-op. The dashboard treats a missing chip ID field
  // exactly like older firmware that predates this feature, so this is
  // a safe (if less capable) fallback rather than fabricating a fake ID.
  void PrintUniqueChipIdIfAvailable() {}
#else
  #include <Keyboard.h>
  void ButtonStart() { Keyboard.begin(); }
  void ButtonPress(uint8_t button_num) { Keyboard.press('a' + button_num - 1); }
  void ButtonRelease(uint8_t button_num) { Keyboard.release('a' + button_num - 1); }
  bool ButtonSend() { return true; }
  // Same reasoning as the USE_ARDUINO_JOYSTICK_LIBRARY branch above.
  void PrintUniqueChipIdIfAvailable() {}
#endif

/*===========================================================================*/
// HARDWARE LIMITS
// ----------------
// These define the MAXIMUM the firmware supports. The actual number of
// sensors in use is configured live from the webfsr dashboard (or via
// serial commands) and saved to EEPROM -- no reflashing needed when you
// change FSR count or LED layout.
//
// NOTE ON LED DATA PIN: some boards in the field have the LED strip wired
// to pin 6, others to pin 7. Since FastLED needs its data pin as a
// compile-time template constant (not something EEPROM-configurable like
// the settings above), this firmware drives LED data out BOTH pin 6 and
// pin 7 in setup() so a single build works on either board -- see the
// FastLED.addLeds() calls there rather than a single DATA_PIN constant.
#define MAX_SENSORS   8
#define NUM_LEDS      64

// Physical analog pins available for sensors, in order. Sensor 0 always
// uses kAnalogPins[0], sensor 1 uses kAnalogPins[1], etc.
const uint8_t kAnalogPins[MAX_SENSORS] = { A0, A1, A2, A3, A4, A5, A6, A7 };

CRGB leds[NUM_LEDS];
uint8_t currentBrightness = 60;

void LedZoneOn(uint8_t led_offset, uint8_t led_count, CRGB color) {
  uint8_t end = led_offset + led_count;
  if (end > NUM_LEDS) end = NUM_LEDS;
  for (uint8_t i = led_offset; i < end; ++i) {
    leds[i] = color;
  }
  FastLED.show();
}

void LedZoneOff(uint8_t led_offset, uint8_t led_count) {
  uint8_t end = led_offset + led_count;
  if (end > NUM_LEDS) end = NUM_LEDS;
  for (uint8_t i = led_offset; i < end; ++i) {
    leds[i] = CRGB::Black;
  }
  FastLED.show();
}

/*===========================================================================*/

const int16_t kDefaultThreshold = 1000;
const size_t  kWindowSize       = 50;
const long    kBaudRate         = 115200;
uint8_t       curButtonNum      = 1;

/*===========================================================================*/

class WeightedMovingAverage {
 public:
  WeightedMovingAverage(size_t size) :
      size_(min(size, kWindowSize)), cur_sum_(0), cur_weighted_sum_(0),
      values_{}, cur_count_(0) {}
  int16_t GetAverage(int16_t value) {
    int32_t next_sum = cur_sum_ + value - values_[cur_count_];
    int32_t next_weighted_sum = cur_weighted_sum_ + size_ * value - cur_sum_;
    cur_sum_ = next_sum;
    cur_weighted_sum_ = next_weighted_sum;
    values_[cur_count_] = value;
    cur_count_ = (cur_count_ + 1) % size_;
    int16_t sum_weights = ((size_ * (size_ + 1)) / 2);
    return next_weighted_sum / sum_weights;
  }
  WeightedMovingAverage() = delete;
 private:
  size_t  size_;
  int32_t cur_sum_;
  int32_t cur_weighted_sum_;
  int16_t values_[kWindowSize];
  size_t  cur_count_;
};

class HullMovingAverage {
 public:
  HullMovingAverage(size_t size) : wma1_(size/2), wma2_(size), hull_(sqrt(size)) {}
  int16_t GetAverage(int16_t value) {
    int16_t wma1_value = wma1_.GetAverage(value);
    int16_t wma2_value = wma2_.GetAverage(value);
    return hull_.GetAverage(2 * wma1_value - wma2_value);
  }
  HullMovingAverage() = delete;
 private:
  WeightedMovingAverage wma1_, wma2_, hull_;
};

/*===========================================================================*/
// Sensor class -- same evaluation logic as before. Configuration (LED zone,
// color) is now set via Init()/SetLedZone()/SetColor() driven by EEPROM
// or live serial commands rather than hardcoded constructor arguments.

class Sensor {
 public:
  Sensor()
      : initialized_(false),
        pin_value_(A0),
        button_group_(0),
        trigger_threshold_(kDefaultThreshold),
        release_threshold_(kDefaultThreshold - kDefaultPaddingWidth),
        gain_x100_(100),  // 100 = 1.00x, stored as integer to avoid float drift
        release_debounce_ms_(kDefaultReleaseDebounceMs),
        below_release_since_ms_(0),
        was_below_release_(false),
        #if defined(CAN_AVERAGE)
          moving_average_(kWindowSize),
        #endif
        offset_(0),
        led_offset_(0),
        led_count_(0),
        color_(CRGB(255, 0, 0)),
        is_active_(false) {}

  // Called once per active sensor at startup with its pin, saved config,
  // and which sensor index it is (used as the default button group when
  // none has been explicitly assigned -- i.e. "no sharing" by default).
  void Init(uint8_t pin_value, uint8_t led_offset, uint8_t led_count, CRGB color, uint8_t sensor_index) {
    pin_value_    = pin_value;
    led_offset_   = led_offset;
    led_count_    = led_count;
    color_        = color;
    button_group_ = sensor_index;  // default: each sensor is its own group
    initialized_  = true;
  }

  // Reads the sensor and updates is_active_ / LEDs. Does NOT press or
  // release any joystick button directly -- that's now handled centrally
  // by ResolveButtonGroups() after all sensors have been evaluated, so
  // multiple sensors sharing a button_group_ combine correctly (press if
  // ANY member is active, release only if ALL members are inactive) the
  // same way the original single-panel-multi-sensor SensorState worked.
  void EvaluateSensor(bool willSend) {
    if (!initialized_) return;

    analogRead(pin_value_);          // discard first read to flush ADC capacitance
    delayMicroseconds(200);          // allow ADC input to settle before sampling
    int16_t sensor_value = analogRead(pin_value_);

    #if defined(CAN_AVERAGE)
      int16_t averaged = moving_average_.GetAverage(sensor_value) - offset_;
    #else
      int16_t averaged = sensor_value - offset_;
    #endif

    // Apply gain BEFORE clamping so weak sensors (e.g. UX FSR 406) can be
    // boosted to use the full 0-1023 range. gain_x100_ of 100 = 1.00x (no
    // change), 150 = 1.5x boost, 300 = 3x boost (max).
    int32_t amplified = ((int32_t)averaged * gain_x100_) / 100;
    cur_value_ = constrain(amplified, 0, 1023);

    if (!willSend) return;

    // Dual threshold hysteresis: trigger_threshold_ is the higher bar to
    // turn ON, release_threshold_ is the lower bar to turn OFF. The gap
    // between them (rather than a small +/- padding around one value)
    // lets a partial foot lift between rapid hits still register as a
    // release, fixing missed double-taps at high speed.
    bool should_be_on = (cur_value_ >= trigger_threshold_);
    bool below_release_now = (cur_value_ < release_threshold_);

    // RELEASE DEBOUNCE: require the sensor to stay continuously below
    // release_threshold_ for release_debounce_ms_ before actually
    // releasing, instead of releasing the instant a single sample dips
    // below the line. Without this, a moderate Trigger/Release gap
    // (e.g. 500/300) still produced spurious held-misses during long
    // holds: resting foot pressure on a metal pad panel naturally
    // fluctuates as the panel flexes and the player's weight shifts/
    // fatigues over a stamina chart, and even a single noisy 1ms sample
    // dipping under the Release line was enough to cut the hold. This
    // debounce absorbs that kind of brief, real-world pressure noise
    // while still releasing promptly (within release_debounce_ms_) on a
    // genuine foot-lift. Defaults to kDefaultReleaseDebounceMs and is
    // tunable per-sensor via SetReleaseDebounceMs/the "d" serial command.
    if (below_release_now) {
      if (!was_below_release_) {
        below_release_since_ms_ = millis();
        was_below_release_ = true;
      }
    } else {
      was_below_release_ = false;
    }

    bool should_be_off = was_below_release_ &&
        (millis() - below_release_since_ms_ >= release_debounce_ms_);

    if (!is_active_ && should_be_on) {
      LedZoneOn(led_offset_, led_count_, color_);
      is_active_ = true;
      // A fresh press always cancels any in-progress release debounce
      // timer -- if you pressed firmly again, the brief dip clearly
      // wasn't a real release.
      was_below_release_ = false;
    } else if (is_active_ && should_be_off) {
      LedZoneOff(led_offset_, led_count_);
      is_active_ = false;
    }
  }

  // Legacy single-threshold API (kept for old "0 <sensor> <val>" serial
  // command compatibility). Sets trigger threshold directly and derives
  // a sane release threshold using the default padding gap below it.
  void UpdateThreshold(int16_t t) {
    trigger_threshold_ = t;
    int16_t derived_release = t - kDefaultPaddingWidth;
    release_threshold_ = (derived_release < 0) ? 0 : derived_release;
  }

  // New explicit dual-threshold API.
  void SetTriggerThreshold(int16_t t) { trigger_threshold_ = constrain(t, 0, 1023); }
  void SetReleaseThreshold(int16_t t) { release_threshold_ = constrain(t, 0, 1023); }
  void SetGain(uint16_t gain_x100)    { gain_x100_ = constrain(gain_x100, (uint16_t)10, (uint16_t)500); }
  void SetButtonGroup(uint8_t group)  { button_group_ = group; }
  // Release debounce window in milliseconds -- how long the sensor must
  // read continuously below release_threshold_ before actually
  // releasing. 0 disables debouncing entirely (instant release, the
  // original behavior). Clamped to a sane max so a misconfigured value
  // can't make releases feel laggy/unresponsive.
  void SetReleaseDebounceMs(uint16_t ms) { release_debounce_ms_ = constrain(ms, (uint16_t)0, (uint16_t)100); }

  int16_t UpdateOffset()           { offset_ = cur_value_; return offset_; }
  int16_t GetCurValue()            { return cur_value_; }
  int16_t GetThreshold()           { return trigger_threshold_; }  // legacy alias
  int16_t GetTriggerThreshold()    { return trigger_threshold_; }
  int16_t GetReleaseThreshold()    { return release_threshold_; }
  uint16_t GetGain()               { return gain_x100_; }
  uint16_t GetReleaseDebounceMs()  { return release_debounce_ms_; }
  uint8_t GetLedOffset()           { return led_offset_; }
  uint8_t GetLedCount()            { return led_count_; }
  CRGB    GetColor()               { return color_; }
  uint8_t GetButtonGroup()         { return button_group_; }
  bool    IsActive()               { return is_active_; }

  void SetLedZone(uint8_t offset, uint8_t count) {
    LedZoneOff(led_offset_, led_count_);
    led_offset_ = offset;
    led_count_  = count;
    if (is_active_) LedZoneOn(led_offset_, led_count_, color_);
  }

  void SetColor(CRGB color) {
    color_ = color;
    if (is_active_) LedZoneOn(led_offset_, led_count_, color_);
  }

 private:
  bool    initialized_  = false;
  uint8_t pin_value_;

  // Sensors that share the same button_group_ value combine into a single
  // joystick button: pressed if ANY sensor in the group is active,
  // released only when ALL sensors in the group are inactive. This is
  // what lets two FSRs both mapped to "Down", for example, register as
  // ONE button to ITGMania instead of two separate inputs.
  uint8_t button_group_;

  int16_t trigger_threshold_;
  int16_t release_threshold_;
  uint16_t gain_x100_;  // gain * 100, e.g. 150 = 1.5x. Range 10-500 (0.1x-5.0x).

  // Release debounce state -- see EvaluateSensor for the full
  // explanation. release_debounce_ms_ is the configured window;
  // below_release_since_ms_/was_below_release_ track how long the
  // current below-threshold streak has lasted.
  uint16_t release_debounce_ms_;
  unsigned long below_release_since_ms_;
  bool was_below_release_;

  #if defined(CAN_AVERAGE)
  HullMovingAverage moving_average_;
  #endif
  int16_t cur_value_  = 0;
  int16_t offset_     = 0;

  uint8_t led_offset_;
  uint8_t led_count_;
  CRGB    color_;
  bool    is_active_ = false;  // sensing state, independent of joystick button state

  static const int16_t kDefaultPaddingWidth = 20;
  // Default release debounce window. 15ms is short enough to feel
  // completely instant for a genuine foot-lift, but long enough to
  // absorb the kind of brief, single-sample pressure noise that metal
  // pad panels produce as they flex under shifting body weight during
  // long holds.
  static const uint16_t kDefaultReleaseDebounceMs = 15;
};

/*===========================================================================*/
// ACTIVE SENSOR COUNT
// --------------------
// This is the only thing that determines how many FSRs are live. It's
// loaded from EEPROM at startup (set previously via webfsr or serial "n"
// command) and defaults to 4 on a brand new, never-configured Teensy.
size_t kNumSensors = 4;

Sensor kSensors[MAX_SENSORS];

// Tracks the joystick button press/release state PER BUTTON GROUP, not
// per sensor. Index = button group number (0 to MAX_SENSORS-1, since a
// group number can never exceed the sensor count). This is what actually
// gets pressed/released, separately from each Sensor's own is_active_.
bool   kButtonGroupPressed[MAX_SENSORS] = { false };
uint8_t kButtonGroupJoystickNum[MAX_SENSORS] = { 0 };  // assigned once, lazily

// Called once per loop after all sensors have been evaluated. For each
// distinct button_group_ value in use, presses the joystick button if
// ANY member sensor is active, and releases it only once ALL member
// sensors in that group are inactive. This is the OR-press / AND-release
// behavior from the original SensorState design, generalized to work
// with the fully dynamic, EEPROM-configurable sensor list.
void ResolveButtonGroups() {
  // For each group, OR together the active state of every sensor that
  // belongs to it.
  bool group_should_be_on[MAX_SENSORS] = { false };
  bool group_in_use[MAX_SENSORS] = { false };

  for (size_t i = 0; i < kNumSensors; ++i) {
    uint8_t group = kSensors[i].GetButtonGroup();
    if (group >= MAX_SENSORS) continue;  // safety clamp, shouldn't happen
    group_in_use[group] = true;
    if (kSensors[i].IsActive()) group_should_be_on[group] = true;
  }

  for (size_t g = 0; g < MAX_SENSORS; ++g) {
    if (!group_in_use[g]) continue;

    // Lazily assign a joystick button number the first time this group
    // is actually used, so button numbers stay compact (1, 2, 3...)
    // rather than leaving gaps for unused group slots.
    if (kButtonGroupJoystickNum[g] == 0) {
      kButtonGroupJoystickNum[g] = curButtonNum++;
    }
    uint8_t joystick_num = kButtonGroupJoystickNum[g];

    if (!kButtonGroupPressed[g] && group_should_be_on[g]) {
      ButtonPress(joystick_num);
      kButtonGroupPressed[g] = true;
    } else if (kButtonGroupPressed[g] && !group_should_be_on[g]) {
      ButtonRelease(joystick_num);
      kButtonGroupPressed[g] = false;
    }
  }
}

/*===========================================================================*/
// EEPROM LAYOUT
// --------------
// Byte 0:        marker (0xA8) -- indicates EEPROM has valid saved config
// Byte 1:        kNumSensors (1-8)
// Byte 2:        currentBrightness
// Bytes 3..:     per-sensor config block, 13 bytes each:
//                  [0] led_offset
//                  [1] led_count
//                  [2] color R
//                  [3] color G
//                  [4] color B
//                  [5] trigger threshold low byte
//                  [6] trigger threshold high byte
//                  [7] release threshold low byte
//                  [8] release threshold high byte
//                  [9] gain_x100 low byte
//                  [10] gain_x100 high byte
//                  [11] button_group -- sensors sharing the same group
//                       number combine into one joystick button (OR to
//                       press, AND to release). Defaults to the sensor's
//                       own index, meaning "no sharing" out of the box.
//                  [12] release_debounce_ms -- how long (ms) the sensor
//                       must read continuously below release_threshold_
//                       before actually releasing. Protects holds from
//                       momentary pressure noise. 0-100ms range fits in
//                       one byte. Defaults to kDefaultReleaseDebounceMs.
// After all sensor blocks: threshold save-slot region (existing system)
//
// Total header region = 3 + (MAX_SENSORS * 13) bytes, reserved regardless
// of how many sensors are actually active so growing kNumSensors later
// never collides with the threshold save-slot region below it.

// FIRMWARE VERSION -- reported over serial via the 'i' command so WebFsr
// can check for and apply updates, and warn before an update that would
// reset EEPROM-saved calibration (by comparing kEepromMarker below
// against what a candidate release would ship with). Bump on every
// public release.
const char* const kFirmwareVersion = "1.0.4";

const uint8_t  kEepromMarker     = 0xA8;
const size_t   kConfigBytesPerSensor = 13;
const size_t   kConfigHeaderSize = 3 + (MAX_SENSORS * kConfigBytesPerSensor);

// Write-if-changed wrapper around EEPROM.write(). On Teensy (and most
// other boards), EEPROM is emulated in flash rather than being true
// EEPROM hardware. That emulation periodically has to erase and
// recompact a flash sector once enough bytes have been dirtied -- and
// that erase blocks the whole chip, USB included, for its duration.
// That's the actual mechanism behind "the pad just stops responding for
// a few seconds and then comes back."
//
// SaveSensorConfigToEeprom() below rewrites the ENTIRE config header --
// all MAX_SENSORS slots, 107 bytes on this build (13 bytes/sensor) --
// on every single tuning command (y/r/g/m/d/l/z/b/n), even though only
// one or two bytes actually changed. Most Teensy cores already skip a
// physical write when the value is unchanged, but making that explicit
// here guarantees the behavior regardless of core version, and costs
// nothing extra since EEPROM.read() is cheap (no flash erase involved,
// unlike write()). This turns "rewrite 107 bytes" into "compare 107
// bytes, write ~0-2", which is what actually keeps flash wear/compaction
// pauses rare instead of something a single Gain/Debounce slider drag
// can trigger.
void EepromWriteIfChanged(size_t addr, uint8_t val) {
  if (EEPROM.read(addr) != val) EEPROM.write(addr, val);
}

void SaveSensorConfigToEeprom() {
  EepromWriteIfChanged(0, kEepromMarker);
  EepromWriteIfChanged(1, (uint8_t)kNumSensors);
  EepromWriteIfChanged(2, currentBrightness);
  for (size_t i = 0; i < MAX_SENSORS; ++i) {
    size_t base = 3 + i * kConfigBytesPerSensor;
    uint8_t offset   = (i < kNumSensors) ? kSensors[i].GetLedOffset()         : 0;
    uint8_t count    = (i < kNumSensors) ? kSensors[i].GetLedCount()          : 0;
    CRGB    c        = (i < kNumSensors) ? kSensors[i].GetColor()             : CRGB(255,0,0);
    int16_t trig     = (i < kNumSensors) ? kSensors[i].GetTriggerThreshold()  : kDefaultThreshold;
    int16_t rel      = (i < kNumSensors) ? kSensors[i].GetReleaseThreshold()  : (kDefaultThreshold - 20);
    uint16_t gain    = (i < kNumSensors) ? kSensors[i].GetGain()              : 100;
    uint8_t  group   = (i < kNumSensors) ? kSensors[i].GetButtonGroup()       : (uint8_t)i;
    uint8_t  debounce= (i < kNumSensors) ? (uint8_t)kSensors[i].GetReleaseDebounceMs() : 15;
    EepromWriteIfChanged(base + 0, offset);
    EepromWriteIfChanged(base + 1, count);
    EepromWriteIfChanged(base + 2, c.r);
    EepromWriteIfChanged(base + 3, c.g);
    EepromWriteIfChanged(base + 4, c.b);
    EepromWriteIfChanged(base + 5, trig & 0xFF);
    EepromWriteIfChanged(base + 6, trig >> 8);
    EepromWriteIfChanged(base + 7, rel & 0xFF);
    EepromWriteIfChanged(base + 8, rel >> 8);
    EepromWriteIfChanged(base + 9, gain & 0xFF);
    EepromWriteIfChanged(base + 10, gain >> 8);
    EepromWriteIfChanged(base + 11, group);
    EepromWriteIfChanged(base + 12, debounce);
  }
}

// Loads sensor count, brightness, zones, colors, thresholds, gain,
// button groups, and release debounce from EEPROM. Returns true if valid
// saved config was found, false if this is a fresh/never-configured
// Teensy (caller should apply defaults).
bool LoadSensorConfigFromEeprom() {
  if (EEPROM.read(0) != kEepromMarker) return false;

  uint8_t savedCount = EEPROM.read(1);
  if (savedCount < 1 || savedCount > MAX_SENSORS) return false;
  kNumSensors = savedCount;
  currentBrightness = EEPROM.read(2);

  for (size_t i = 0; i < kNumSensors; ++i) {
    size_t base = 3 + i * kConfigBytesPerSensor;
    uint8_t offset   = EEPROM.read(base + 0);
    uint8_t count    = EEPROM.read(base + 1);
    uint8_t r        = EEPROM.read(base + 2);
    uint8_t g        = EEPROM.read(base + 3);
    uint8_t b        = EEPROM.read(base + 4);
    int16_t trig     = (EEPROM.read(base + 6) << 8)  | EEPROM.read(base + 5);
    int16_t rel      = (EEPROM.read(base + 8) << 8)  | EEPROM.read(base + 7);
    uint16_t gain    = (EEPROM.read(base + 10) << 8) | EEPROM.read(base + 9);
    uint8_t group    = EEPROM.read(base + 11);
    uint8_t debounce = EEPROM.read(base + 12);
    if (count == 0) count = 4; // sane fallback if a slot was never written
    if (gain == 0)  gain  = 100; // sane fallback (1.0x) if never written
    kSensors[i].Init(kAnalogPins[i], offset, count, CRGB(r, g, b), i);
    kSensors[i].SetTriggerThreshold(trig);
    kSensors[i].SetReleaseThreshold(rel);
    kSensors[i].SetGain(gain);
    kSensors[i].SetButtonGroup(group);
    kSensors[i].SetReleaseDebounceMs(debounce);
  }
  return true;
}

// Applies sensible defaults for a brand-new Teensy: N sensors, each with
// 4 LEDs in sequence, default threshold, basic color cycle.
void ApplyDefaultSensorConfig(size_t count) {
  const CRGB defaultColors[8] = {
    CRGB(255,0,0), CRGB(0,0,255), CRGB(255,165,0), CRGB(0,255,0),
    CRGB(204,68,255), CRGB(0,221,204), CRGB(255,221,0), CRGB(255,102,136),
  };
  kNumSensors = constrain(count, (size_t)1, (size_t)MAX_SENSORS);
  for (size_t i = 0; i < kNumSensors; ++i) {
    kSensors[i].Init(kAnalogPins[i], i * 4, 4, defaultColors[i % 8], i);
    kSensors[i].UpdateThreshold(kDefaultThreshold);
  }
  SaveSensorConfigToEeprom();
}

/*===========================================================================*/
// Threshold save-slot system (separate from sensor config above).
// Lives after the config header region so it never collides with it.

class EepromProcessor {
  public:
    EepromProcessor() : last_used_save_slot_(-1) {}
    void SaveThresholds() {
      if (last_used_save_slot_ == -1) {
        SaveThresholdsInSlot(0); last_used_save_slot_ = 0;
      } else if (last_used_save_slot_ == LastSaveSlot()) {
        SaveThresholdsInSlot(0);
        for (int s = 1; s <= LastSaveSlot(); ++s) MarkSlotTaken(s, false);
        last_used_save_slot_ = 0;
      } else {
        SaveThresholdsInSlot(last_used_save_slot_++);
      }
      Serial.print("s");
      for (size_t i = 0; i < kNumSensors; ++i) {
        Serial.print(" "); Serial.print(kSensors[i].GetThreshold());
      }
      Serial.print("\n");
    }
    void LoadThresholds() {
      FindLastUsedSaveSlot();
      if (last_used_save_slot_ == -1) return;
      for (size_t i = 0; i < kNumSensors; ++i) RestoreThreshold(i);
    }
  private:
    size_t SlotRegionStart() { return kConfigHeaderSize; }
    size_t SaveSlotSizeBytes() { return (MAX_SENSORS + 1) * 2; }
    int LastSaveSlot() {
      return ((EEPROM.length() - SlotRegionStart()) / SaveSlotSizeBytes()) - 1;
    }
    void SaveThreshold(int slot, size_t idx, int16_t val) {
      // Same write-if-changed treatment as SaveSensorConfigToEeprom above --
      // SaveThresholds() (the "s" command) and preset/backup-restore flows
      // call this once per sensor per save, so an unnecessary physical
      // write here contributes to the same flash-compaction risk.
      size_t off = SlotRegionStart() + slot * SaveSlotSizeBytes();
      EepromWriteIfChanged(off + idx*2,   val & 0xFF);
      EepromWriteIfChanged(off + idx*2+1, val >> 8);
    }
    int16_t ReadThreshold(int slot, size_t idx) {
      size_t off = SlotRegionStart() + slot * SaveSlotSizeBytes();
      return (EEPROM.read(off+idx*2+1) << 8) | EEPROM.read(off+idx*2);
    }
    void MarkSlotTaken(int slot, bool taken) {
      SaveThreshold(slot, MAX_SENSORS, taken ? SAVE_SLOT_TAKEN_MARKER : 0);
    }
    bool IsSlotTaken(int slot) {
      return ReadThreshold(slot, MAX_SENSORS) == SAVE_SLOT_TAKEN_MARKER;
    }
    void FindLastUsedSaveSlot() {
      for (int s = LastSaveSlot(); s >= 0; --s) {
        if (IsSlotTaken(s)) { last_used_save_slot_ = s; return; }
      }
      last_used_save_slot_ = -1;
    }
    void RestoreThreshold(size_t idx) {
      kSensors[idx].UpdateThreshold(ReadThreshold(last_used_save_slot_, idx));
    }
    void SaveThresholdsInSlot(int slot) {
      for (size_t i = 0; i < kNumSensors; ++i)
        SaveThreshold(slot, i, kSensors[i].GetThreshold());
      MarkSlotTaken(slot, true);
    }
    const int16_t SAVE_SLOT_TAKEN_MARKER = -42;
    int last_used_save_slot_;
};

/*===========================================================================*/

// Prints LED config for all active sensors.
// Format: "c <s0_r> <s0_g> <s0_b> <s0_off> <s0_cnt> ... <brightness>"
void PrintLedConfig() {
  Serial.print("c");
  for (size_t i = 0; i < kNumSensors; ++i) {
    CRGB c = kSensors[i].GetColor();
    Serial.print(" "); Serial.print(c.r);
    Serial.print(" "); Serial.print(c.g);
    Serial.print(" "); Serial.print(c.b);
    Serial.print(" "); Serial.print(kSensors[i].GetLedOffset());
    Serial.print(" "); Serial.print(kSensors[i].GetLedCount());
  }
  Serial.print(" "); Serial.print(currentBrightness);
  Serial.print("\n");
}

class SerialProcessor {
 public:
  void Init(long baud_rate) { Serial.begin(baud_rate); }

  void CheckAndMaybeProcessData() {
    while (Serial.available() > 0) {
      size_t bytes_read = Serial.readBytesUntil('\n', buffer_, kBufferSize - 1);
      buffer_[bytes_read] = '\0';
      if (bytes_read == 0) return;
      switch (buffer_[0]) {
        case 'o': case 'O': UpdateOffsets();                    break;
        case 'v': case 'V': PrintValues();                      break;
        case 't': case 'T': PrintThresholds();                  break;
        case 's': case 'S': eeprom_processor_.SaveThresholds(); break;
        case 'q': case 'Q': PrintLedConfig();                   break;
        // "z <sensor> <offset> <count>" -- set LED zone for a sensor
        case 'z': case 'Z': UpdateSensorZone();                 break;
        // "l <sensor> <r> <g> <b>" or "l a <r> <g> <b>" -- set color
        case 'l': case 'L': UpdateSensorColor();                break;
        // "b <0-255>" -- set brightness
        case 'b': case 'B': UpdateBrightness();                 break;
        // "n <count>" -- set number of active sensors (1-8) and re-init
        case 'n': case 'N': UpdateSensorCount();                break;
        // "y <sensor> <0-1023>" -- set TRIGGER (ON) threshold
        case 'y': case 'Y': UpdateTriggerThreshold();           break;
        // "r <sensor> <0-1023>" -- set RELEASE (OFF) threshold
        case 'r': case 'R': UpdateReleaseThreshold();           break;
        // "g <sensor> <gain_x100>" -- set gain, e.g. 150 = 1.5x. 'g a <val>'
        // applies the same gain to all sensors at once.
        case 'g': case 'G': UpdateGain();                       break;
        // "m <sensor> <group>" -- set button group. Sensors sharing the
        // same group number combine into ONE joystick button (any-active
        // = pressed, all-inactive = released). Use this to make a 2nd
        // FSR on the same panel (e.g. a second "Down") register as the
        // same input to ITGMania instead of a separate button.
        case 'm': case 'M': UpdateButtonGroup();                break;
        // "d <sensor> <0-100>" or "d a <0-100>" -- set release debounce
        // window in ms. The sensor must read continuously below
        // release_threshold_ for this long before actually releasing,
        // protecting holds from brief pressure noise (e.g. resting
        // weight shifting on a metal pad panel). 0 = instant release,
        // no debounce.
        case 'd': case 'D': UpdateReleaseDebounce();            break;
        // "p <sensor>" -- print full tuning info for one sensor (trigger,
        // release, gain, button group, release debounce, current live
        // value) -- handy for live tuning UI
        case 'p': case 'P': PrintSensorTuning();                break;
        case 'i': case 'I': PrintIdentify();                    break;
        case '0' ... '9':   UpdateAndPrintThreshold(bytes_read); // fall through
        default: break;
      }
    }
  }

  // "y <sensor_index> <0-1023>" -- explicit trigger threshold.
  void UpdateTriggerThreshold() {
    char* p = buffer_ + 1;
    char* end;
    int sensor = (int)strtol(p, &end, 10); p = end;
    int val    = (int)strtol(p, &end, 10);
    if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("y_err: bad sensor\n"); return; }
    if (val < 0 || val > 1023) { Serial.print("y_err: bad value\n"); return; }
    kSensors[sensor].SetTriggerThreshold((int16_t)val);
    SaveSensorConfigToEeprom();
    PrintSensorTuningFor(sensor);
  }

  // "r <sensor_index> <0-1023>" -- explicit release threshold.
  void UpdateReleaseThreshold() {
    char* p = buffer_ + 1;
    char* end;
    int sensor = (int)strtol(p, &end, 10); p = end;
    int val    = (int)strtol(p, &end, 10);
    if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("r_err: bad sensor\n"); return; }
    if (val < 0 || val > 1023) { Serial.print("r_err: bad value\n"); return; }
    kSensors[sensor].SetReleaseThreshold((int16_t)val);
    SaveSensorConfigToEeprom();
    PrintSensorTuningFor(sensor);
  }

  // "g <sensor_index> <gain_x100>" or "g a <gain_x100>" -- gain multiplier.
  // gain_x100: 100 = 1.0x (no change), 150 = 1.5x boost, 300 = 3.0x boost.
  // Valid range enforced by Sensor::SetGain is 10-500 (0.1x to 5.0x).
  void UpdateGain() {
    char* p = buffer_ + 1;
    while (*p == ' ') p++;
    bool all = (*p == 'a' || *p == 'A');
    int sensor = -1;
    if (!all) {
      char* end;
      sensor = (int)strtol(p, &end, 10);
      if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("g_err: bad sensor\n"); return; }
      p = end;
    } else {
      p++;
    }
    int gain = (int)strtol(p, nullptr, 10);
    if (gain < 10 || gain > 500) { Serial.print("g_err: bad gain\n"); return; }

    if (all) {
      for (size_t i = 0; i < kNumSensors; ++i) kSensors[i].SetGain((uint16_t)gain);
    } else {
      kSensors[sensor].SetGain((uint16_t)gain);
    }
    SaveSensorConfigToEeprom();
    if (!all) {
      PrintSensorTuningFor(sensor);
    } else {
      Serial.print("g_ok all="); Serial.print(gain); Serial.print("\n");
    }
  }

  // "m <sensor_index> <group>" -- set which button group a sensor belongs
  // to. group must be a valid sensor index (0 to kNumSensors-1) -- you're
  // effectively saying "share a button with sensor <group>". To make a
  // sensor independent again, set its group back to its own index.
  void UpdateButtonGroup() {
    char* p = buffer_ + 1;
    char* end;
    int sensor = (int)strtol(p, &end, 10); p = end;
    int group  = (int)strtol(p, &end, 10);
    if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("m_err: bad sensor\n"); return; }
    if (group  < 0 || group  >= (int)kNumSensors) { Serial.print("m_err: bad group\n"); return; }
    kSensors[sensor].SetButtonGroup((uint8_t)group);
    SaveSensorConfigToEeprom();
    PrintSensorTuningFor(sensor);
  }

  // "d <sensor_index> <0-100>" or "d a <0-100>" -- release debounce
  // window in milliseconds. See EvaluateSensor for the full rationale:
  // protects long holds from being cut short by brief, real-world
  // pressure noise (e.g. resting foot weight shifting on a metal pad
  // panel) without meaningfully delaying genuine releases.
  void UpdateReleaseDebounce() {
    char* p = buffer_ + 1;
    while (*p == ' ') p++;
    bool all = (*p == 'a' || *p == 'A');
    int sensor = -1;
    if (!all) {
      char* end;
      sensor = (int)strtol(p, &end, 10);
      if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("d_err: bad sensor\n"); return; }
      p = end;
    } else {
      p++;
    }
    int ms = (int)strtol(p, nullptr, 10);
    if (ms < 0 || ms > 100) { Serial.print("d_err: bad value\n"); return; }

    if (all) {
      for (size_t i = 0; i < kNumSensors; ++i) kSensors[i].SetReleaseDebounceMs((uint16_t)ms);
    } else {
      kSensors[sensor].SetReleaseDebounceMs((uint16_t)ms);
    }
    SaveSensorConfigToEeprom();
    if (!all) {
      PrintSensorTuningFor(sensor);
    } else {
      Serial.print("d_ok all="); Serial.print(ms); Serial.print("\n");
    }
  }

  // "p <sensor_index>" -- print tuning info for one sensor.
  void PrintSensorTuning() {
    char* p = buffer_ + 1;
    int sensor = (int)strtol(p, nullptr, 10);
    if (sensor < 0 || sensor >= (int)kNumSensors) { Serial.print("p_err: bad sensor\n"); return; }
    PrintSensorTuningFor(sensor);
  }

  // Format: "p <sensor> <trigger> <release> <gain_x100> <button_group> <release_debounce_ms> <live_value>"
  // Used both as a direct response to 'p' and as confirmation after
  // y/r/g/m/d commands so the dashboard can update its UI immediately.
  void PrintSensorTuningFor(int sensor) {
    Serial.print("p ");
    Serial.print(sensor); Serial.print(" ");
    Serial.print(kSensors[sensor].GetTriggerThreshold()); Serial.print(" ");
    Serial.print(kSensors[sensor].GetReleaseThreshold()); Serial.print(" ");
    Serial.print(kSensors[sensor].GetGain()); Serial.print(" ");
    Serial.print(kSensors[sensor].GetButtonGroup()); Serial.print(" ");
    Serial.print(kSensors[sensor].GetReleaseDebounceMs()); Serial.print(" ");
    Serial.print(kSensors[sensor].GetCurValue());
    Serial.print("\n");
  }

  // "n <count>" -- change how many FSR sensors are active.
  // New sensors get sequential default LED zones appended after the
  // current highest zone in use. Existing sensors keep their config.

  void UpdateSensorCount() {
    char* p = buffer_ + 1;
    int newCount = (int)strtol(p, nullptr, 10);
    if (newCount < 1 || newCount > (int)MAX_SENSORS) {
      Serial.print("n_err: bad count\n");
      return;
    }

    const CRGB defaultColors[8] = {
      CRGB(255,0,0), CRGB(0,0,255), CRGB(255,165,0), CRGB(0,255,0),
      CRGB(204,68,255), CRGB(0,221,204), CRGB(255,221,0), CRGB(255,102,136),
    };

    size_t oldCount = kNumSensors;

    if ((size_t)newCount > oldCount) {
      // Find next free LED offset after existing zones.
      uint8_t nextOffset = 0;
      for (size_t i = 0; i < oldCount; ++i) {
        uint8_t end = kSensors[i].GetLedOffset() + kSensors[i].GetLedCount();
        if (end > nextOffset) nextOffset = end;
      }
      for (size_t i = oldCount; i < (size_t)newCount; ++i) {
        uint8_t offset = nextOffset;
        uint8_t count  = 4;
        if (offset + count > NUM_LEDS) count = (NUM_LEDS > offset) ? (NUM_LEDS - offset) : 1;
        kSensors[i].Init(kAnalogPins[i], offset, count, defaultColors[i % 8], i);
        kSensors[i].UpdateThreshold(kDefaultThreshold);
        nextOffset += count;
      }
    }
    // If shrinking, turn off LEDs for sensors that are being deactivated.
    if ((size_t)newCount < oldCount) {
      for (size_t i = newCount; i < oldCount; ++i) {
        LedZoneOff(kSensors[i].GetLedOffset(), kSensors[i].GetLedCount());
      }
    }

    kNumSensors = (size_t)newCount;
    SaveSensorConfigToEeprom();
    Serial.print("n_ok count="); Serial.print(kNumSensors); Serial.print("\n");
    PrintLedConfig();
  }

  // "z <sensor_index> <led_offset> <led_count>"
  void UpdateSensorZone() {
    char* p = buffer_ + 1;
    char* end;
    int sensor = (int)strtol(p, &end, 10); p = end;
    int offset = (int)strtol(p, &end, 10); p = end;
    int count  = (int)strtol(p, &end, 10);

    if (sensor < 0 || sensor >= (int)kNumSensors) {
      Serial.print("z_err: bad sensor\n"); return;
    }
    if (offset < 0 || offset >= NUM_LEDS) {
      Serial.print("z_err: bad offset\n"); return;
    }
    if (count < 1 || offset + count > NUM_LEDS) {
      Serial.print("z_err: bad count\n"); return;
    }

    kSensors[sensor].SetLedZone((uint8_t)offset, (uint8_t)count);
    SaveSensorConfigToEeprom();
    Serial.print("z_ok sensor="); Serial.print(sensor);
    Serial.print(" offset=");     Serial.print(offset);
    Serial.print(" count=");      Serial.print(count);
    Serial.print("\n");
    PrintLedConfig();
  }

  // "l <sensor_index> <r> <g> <b>" or "l a <r> <g> <b>"
  void UpdateSensorColor() {
    char* p = buffer_ + 1;
    while (*p == ' ') p++;

    bool all = (*p == 'a' || *p == 'A');
    int sensor = -1;
    if (!all) {
      char* end;
      sensor = (int)strtol(p, &end, 10);
      if (sensor < 0 || sensor >= (int)kNumSensors) return;
      p = end;
    } else {
      p++;
    }

    char* end;
    uint8_t r = (uint8_t)strtol(p, &end, 10); p = end;
    uint8_t g = (uint8_t)strtol(p, &end, 10); p = end;
    uint8_t b = (uint8_t)strtol(p, &end, 10);

    if (all) {
      for (size_t i = 0; i < kNumSensors; ++i) kSensors[i].SetColor(CRGB(r, g, b));
    } else {
      kSensors[sensor].SetColor(CRGB(r, g, b));
    }
    SaveSensorConfigToEeprom();
    PrintLedConfig();
  }

  void UpdateBrightness() {
    char* p = buffer_ + 1;
    int val = strtol(p, nullptr, 10);
    if (val < 0 || val > 255) return;
    currentBrightness = (uint8_t)val;
    FastLED.setBrightness(currentBrightness);
    FastLED.show();
    SaveSensorConfigToEeprom();
    PrintLedConfig();
  }

  void UpdateAndPrintThreshold(size_t bytes_read) {
    if (bytes_read < 3 || bytes_read > 7) return;
    char* next = nullptr;
    size_t idx = strtoul(buffer_, &next, 10);
    if (idx >= kNumSensors) return;
    int16_t thr = strtol(next, nullptr, 10);
    if (thr < 0 || thr > 1023) return;
    kSensors[idx].UpdateThreshold(thr);
    PrintThresholds();
  }

  void UpdateOffsets() {
    for (size_t i = 0; i < kNumSensors; ++i) kSensors[i].UpdateOffset();
  }
  void PrintValues() {
    Serial.print("v");
    for (size_t i = 0; i < kNumSensors; ++i) {
      Serial.print(" "); Serial.print(kSensors[i].GetCurValue());
    }
    Serial.print("\n");
  }
  void PrintThresholds() {
    Serial.print("t");
    for (size_t i = 0; i < kNumSensors; ++i) {
      Serial.print(" "); Serial.print(kSensors[i].GetThreshold());
    }
    Serial.print("\n");
  }
  // "i" -- identify: firmware version + EEPROM layout marker + sensor
  // count + (where available) a per-board unique chip ID. Lets WebFsr
  // check for updates, warn before an update that would reset saved
  // calibration, and tell two physically distinct pads apart when both
  // are connected to the same computer at once.
  // Format: "i <version> <eeprom_marker_hex> <num_sensors> [<chip_id_hex>]"
  // The trailing chip ID field is only present on MCUs where a genuine
  // factory-unique ID is available (currently Teensy 4.x and RP2040) --
  // see PrintUniqueChipIdIfAvailable() near the top of this file. Omitted
  // entirely (not even a blank field) rather than faked on other
  // targets; the dashboard treats a missing field the same as older
  // firmware that predates this command.
  void PrintIdentify() {
    Serial.print("i ");
    Serial.print(kFirmwareVersion);
    Serial.print(" ");
    if (kEepromMarker < 0x10) Serial.print("0");
    Serial.print(kEepromMarker, HEX);
    Serial.print(" ");
    Serial.print(kNumSensors);
    PrintUniqueChipIdIfAvailable();
    Serial.print("\n");
  }
  void LoadThresholdsFromEeprom() { eeprom_processor_.LoadThresholds(); }

 private:
  static const size_t kBufferSize = 64;
  char buffer_[kBufferSize];
  EepromProcessor eeprom_processor_;
};

/*===========================================================================*/

SerialProcessor serialProcessor;
unsigned long lastSend = 0;
long loopTime = -1;

void setup() {
  // See the "NOTE ON LED DATA PIN" comment near the top of this file for
  // why both pins are driven rather than one DATA_PIN constant.
  FastLED.addLeds<WS2812B, 6, GRB>(leds, NUM_LEDS);
  FastLED.addLeds<WS2812B, 7, GRB>(leds, NUM_LEDS);
  FastLED.clear(true);

  serialProcessor.Init(kBaudRate);
  ButtonStart();

  // Load saved sensor count/zones/colors/brightness from EEPROM.
  // On a brand-new Teensy (no valid marker yet) fall back to 4 sensors
  // with sane defaults and save that as the new baseline.
  if (!LoadSensorConfigFromEeprom()) {
    ApplyDefaultSensorConfig(4);
  }

  FastLED.setBrightness(currentBrightness);
  serialProcessor.LoadThresholdsFromEeprom();



  // ADC fast prescaler disabled -- restores default prescaler (128) for
  // cleaner, more accurate reads. Eliminates crosstalk between sensor pins.
  // #if defined(CLEAR_BIT) && defined(SET_BIT)
  //   SET_BIT(ADCSRA, ADPS2);
  //   CLEAR_BIT(ADCSRA, ADPS1);
  //   CLEAR_BIT(ADCSRA, ADPS0);
  // #endif
}

void loop() {
  unsigned long startMicros = micros();
  static bool willSend;
  willSend = (loopTime == -1 || startMicros - lastSend + loopTime >= 1000);

  serialProcessor.CheckAndMaybeProcessData();
  for (size_t i = 0; i < kNumSensors; ++i) kSensors[i].EvaluateSensor(willSend);

  // Must run AFTER all sensors are evaluated so a group's "any active"
  // OR-logic sees every member's up-to-date state for this cycle, not a
  // partial view from sensors that haven't been read yet this loop.
  if (willSend) ResolveButtonGroups();

  if (willSend) {
    bool sent = ButtonSend();
    if (sent) lastSend = startMicros;
  }
  if (loopTime == -1) loopTime = micros() - startMicros;
}
