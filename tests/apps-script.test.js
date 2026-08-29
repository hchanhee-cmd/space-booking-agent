const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'apps-script-template', 'Code.gs'), 'utf8');
const properties = new Map();
const calendars = new Map();
const scriptProperties = {
  getProperty: key => properties.has(key) ? properties.get(key) : null,
  setProperty: (key, value) => properties.set(key, value),
  getProperties: () => Object.fromEntries(properties)
};
const context = {
  console,
  Date,
  JSON,
  Math,
  Set,
  Map,
  PropertiesService: { getScriptProperties: () => scriptProperties },
  CalendarApp: { getCalendarById: id => calendars.get(id) || null },
  Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.org' }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_, value) => [...crypto.createHash('sha256').update(String(value)).digest()],
    base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
    formatDate: (date, _zone, format) => {
      const iso = new Date(date).toISOString();
      return format === 'HH:mm' ? iso.slice(11, 16) : iso.slice(0, 10);
    },
    getUuid: () => crypto.randomUUID()
  }
};
vm.createContext(context);
vm.runInContext(source, context);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, passed: true, detail: '' }); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); }
}
function evaluate(expression) { return vm.runInContext(expression, context); }
function expect(condition, message) { if (!condition) throw new Error(message); }
function expectThrows(fn, code) { let message = ''; try { fn(); } catch (error) { message = error.message; } expect(message === code, `Expected ${code}, got ${message || 'no error'}`); }

const future = new Date(Date.now() + 10 * 86400000);
const date = future.toISOString().slice(0, 10);
const config = {
  limits: { maxAdvanceDays: 365, maxDurationMinutes: 480, maxRecurrenceCount: 52, alternativeSearchDays: 2, maxRequestsPerMinute: 20 },
  rooms: [{ id: 'room-a', name: 'Room A', calendarId: 'cal-a' }],
  timeZone: 'UTC'
};
const baseRequest = { date, time: '10:00', durationMinutes: 60, subject: 'Test', roomId: 'room-a', recurring: false, recurrenceCount: 1, requestId: '1234567890abcdef', createMeetingEvent: false, addMeet: false };
context.testConfig = config;
context.testRequest = baseRequest;

test('Valid request is normalized', () => expect(evaluate('validateRequest_(testRequest, testConfig, true).durationMinutes') === 60, 'duration mismatch'));
test('Past request is rejected', () => { context.pastRequest = { ...baseRequest, date: '2000-01-01' }; expectThrows(() => evaluate('validateRequest_(pastRequest, testConfig, true)'), 'PAST_TIME'); });
test('Excess duration is rejected', () => { context.longRequest = { ...baseRequest, durationMinutes: 999 }; expectThrows(() => evaluate('validateRequest_(longRequest, testConfig, true)'), 'INVALID_DURATION'); });
test('Excess recurrence is rejected', () => { context.repeatRequest = { ...baseRequest, recurring: true, recurrenceCount: 53 }; expectThrows(() => evaluate('validateRequest_(repeatRequest, testConfig, true)'), 'INVALID_RECURRENCE'); });
test('Weekly recurrence produces exact count', () => { context.normalizedRepeat = evaluate('validateRequest_({...testRequest, recurring:true, recurrenceCount:3}, testConfig, true)'); expect(evaluate('calculateDates_(normalizedRepeat).length') === 3, 'wrong recurrence count'); });
test('Weekly recurrence advances seven days', () => expect(evaluate('(calculateDates_(normalizedRepeat)[1]-calculateDates_(normalizedRepeat)[0]) / 86400000') === 7, 'wrong interval'));

const freeCalendar = { getEvents: () => [], getEventById: () => null };
const busyCalendar = { getEvents: () => [{ getId: () => 'busy-event' }], getEventById: () => null };
calendars.set('cal-a', freeCalendar);
test('Conflict checker reports free calendar', () => expect(evaluate('hasAnyConflict_("cal-a", [new Date(testRequest.date+"T10:00:00")], 60, [])') === false, 'unexpected conflict'));
calendars.set('cal-a', busyCalendar);
test('Conflict checker reports occupied calendar', () => expect(evaluate('hasAnyConflict_("cal-a", [new Date(testRequest.date+"T10:00:00")], 60, [])') === true, 'missing conflict'));
test('Ignored existing event permits reschedule check', () => expect(evaluate('hasAnyConflict_("cal-a", [new Date(testRequest.date+"T10:00:00")], 60, ["busy-event"])') === false, 'old event not ignored'));
calendars.set('cal-a', freeCalendar);
context.normalized = evaluate('validateRequest_(testRequest, testConfig, true)');
test('Alternatives are conflict checked and limited', () => { const suggestions = evaluate('findAlternatives_(testConfig, normalized, 3)'); expect(suggestions.length === 3, 'wrong suggestion count'); });

context.record = { bookingId:'11111111-2222-3333-4444-555555555555', status:'active', userEmail:'owner@example.org', expiresUtc:new Date(Date.now()+86400000).toISOString(), roomName:'Room A' };
evaluate('saveBookingRecord_("A".repeat(64), record)');
test('Management record round-trips with correct owner', () => expect(evaluate('requireOwnedRecord_("A".repeat(64), "owner@example.org").roomName') === 'Room A', 'record mismatch'));
test('Management record hides existence from another owner', () => expectThrows(() => evaluate('requireOwnedRecord_("A".repeat(64), "other@example.org")'), 'BOOKING_NOT_FOUND'));
test('Account booking lookup works for the owner', () => expect(evaluate('requireOwnedRecordById_(record.bookingId, "owner@example.org").record.roomName') === 'Room A', 'account lookup failed'));
test('Account booking lookup rejects another user', () => expectThrows(() => evaluate('requireOwnedRecordById_(record.bookingId, "other@example.org")'), 'BOOKING_NOT_FOUND'));
context.expiredRecord = { ...context.record, expiresUtc:new Date(Date.now()-86400000).toISOString() };
evaluate('saveBookingRecord_("B".repeat(64), expiredRecord)');
test('Expired management token is rejected', () => expectThrows(() => evaluate('requireOwnedRecord_("B".repeat(64), "owner@example.org")'), 'MANAGEMENT_TOKEN_EXPIRED'));
test('Raw management token is not stored', () => expect(![...properties.keys(), ...properties.values()].some(value => String(value).includes('A'.repeat(64))), 'raw token found'));

const installedConfig = {
  appTitle:'Test Booking', timeZone:'UTC', rooms:config.rooms, meetingCalendarId:'',
  access:{ requireSignedInUser:true, allowedDomains:['example.org'], adminEmails:[] },
  logging:{ mode:'disabled', spreadsheetId:'' }, notifications:{ emailConfirmation:false },
  management:{ enabled:true, tokenExpiryDays:30 }, limits:config.limits
};
properties.set('SPACE_BOOKING_CONFIG', JSON.stringify(installedConfig));
test('Internal configuration selects account management', () => expect(evaluate('getPublicConfig().managementMode') === 'account', 'wrong internal mode'));
test('My Bookings returns only the signed-in owner records', () => expect(evaluate('getMyBookings().length') === 1, 'owned booking not listed'));
properties.set('SPACE_BOOKING_CONFIG', JSON.stringify({ ...installedConfig, access:{ requireSignedInUser:false, allowedDomains:[], adminEmails:[] } }));
test('External configuration selects token management', () => expect(evaluate('getPublicConfig().managementMode') === 'token', 'wrong external mode'));
properties.set('SPACE_BOOKING_CONFIG', JSON.stringify(installedConfig));

let createCount = 0;
let firstEventDeleted = false;
const firstEvent = { getId: () => 'created-first', deleteEvent: () => { firstEventDeleted = true; } };
const failingCalendar = {
  createEvent: () => { createCount += 1; if (createCount === 1) return firstEvent; throw new Error('simulated create failure'); },
  getEventById: id => id === 'created-first' ? firstEvent : null,
  getEvents: () => []
};
calendars.set('cal-a', failingCalendar);
context.twoDates = [new Date(`${date}T10:00:00Z`), new Date(`${date}T11:00:00Z`)];
context.testRoom = config.rooms[0];
context.createRequest = { ...baseRequest, createMeetingEvent:false };
context.createConfig = { meetingCalendarId:'' };
test('Partial event creation rolls back earlier writes', () => {
  let failed = false;
  try { evaluate('createBookingEvents_(createConfig, createRequest, testRoom, twoDates, "owner@example.org")'); } catch (error) { failed = true; }
  expect(failed && firstEventDeleted, 'partial event was not rolled back');
});

const failed = results.filter(item => !item.passed);
process.stdout.write(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }));
process.exitCode = failed.length ? 1 : 0;
