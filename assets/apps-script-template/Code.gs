const CONFIG_PROPERTY = 'SPACE_BOOKING_CONFIG';
const BOOKING_PREFIX = 'SPACE_BOOKING_RECORD_';
const REQUEST_TTL_SECONDS = 600;

function doGet() {
  const config = getConfig_();
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle(config.appTitle)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function getPublicConfig() {
  const config = getConfig_();
  assertAuthorized_(config);
  return {
    appTitle: config.appTitle,
    rooms: config.rooms.map(room => ({ id: room.id, name: room.name })),
    limits: config.limits,
    meetAvailable: Boolean(config.meetingCalendarId),
    managementEnabled: config.management.enabled
  };
}

function checkInstallation() {
  const config = getConfig_();
  const checks = [];
  config.rooms.forEach(room => {
    checks.push({ item: `Room: ${room.name}`, ok: Boolean(CalendarApp.getCalendarById(room.calendarId)) });
  });
  if (config.meetingCalendarId) {
    checks.push({ item: 'Meeting calendar', ok: Boolean(CalendarApp.getCalendarById(config.meetingCalendarId)) });
  }
  if (config.logging.mode !== 'disabled') {
    let ok = false;
    try { ok = Boolean(SpreadsheetApp.openById(config.logging.spreadsheetId)); } catch (error) { ok = false; }
    checks.push({ item: 'Reservation log', ok });
  }
  return { ok: checks.every(check => check.ok), checks };
}

function getAvailableRooms(request) {
  const config = getConfig_();
  assertAuthorized_(config);
  const normalized = validateRequest_(request, config, false);
  const dates = calculateDates_(normalized);
  const rooms = config.rooms
    .filter(room => !hasAnyConflict_(room.calendarId, dates, normalized.durationMinutes, []))
    .map(room => ({ id: room.id, name: room.name }));
  return {
    rooms,
    alternatives: rooms.length ? [] : findAlternatives_(config, normalized, 5)
  };
}

function bookRoom(request) {
  const config = getConfig_();
  const userEmail = assertAuthorized_(config);
  const normalized = validateRequest_(request, config, true);
  const room = config.rooms.find(item => item.id === normalized.roomId);
  if (!room) return failure_('UNKNOWN_ROOM', '선택한 공간을 찾을 수 없습니다.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return failure_('SERVER_BUSY', '다른 예약을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');

  let created = [];
  try {
    enforceRateLimit_(userEmail || 'anonymous', config);
    const cached = CacheService.getScriptCache().get(`request:${normalized.requestId}`);
    if (cached) return JSON.parse(cached);

    const dates = calculateDates_(normalized);
    if (hasAnyConflict_(room.calendarId, dates, normalized.durationMinutes, [])) {
      return failure_('ALREADY_BOOKED', '선택한 시간에 이미 예약이 있습니다.', [], findAlternatives_(config, normalized, 5));
    }

    created = createBookingEvents_(config, normalized, room, dates, userEmail);
    const warnings = created.warnings.slice();
    try {
      appendLog_(config, 'BOOKED', dates, normalized, room, userEmail);
    } catch (error) {
      if (config.logging.mode === 'required') {
        return failure_('REQUIRED_LOG_FAILED', '필수 예약 기록을 남기지 못해 새 예약을 되돌렸습니다.', rollback_(created.events));
      }
      if (config.logging.mode === 'optional') warnings.push('예약은 완료됐지만 예약 기록 시트에는 남기지 못했습니다.');
    }

    const token = createManagementToken_();
    const record = {
      version: 1,
      status: 'active',
      createdUtc: new Date().toISOString(),
      updatedUtc: new Date().toISOString(),
      expiresUtc: new Date(Date.now() + config.management.tokenExpiryDays * 86400000).toISOString(),
      userEmail,
      roomId: room.id,
      roomName: room.name,
      subject: normalized.subject,
      date: normalized.date,
      time: normalized.time,
      durationMinutes: normalized.durationMinutes,
      recurrenceCount: normalized.recurrenceCount,
      createMeetingEvent: normalized.createMeetingEvent,
      addMeet: normalized.addMeet,
      events: created.events.map(toEventReference_)
    };
    saveBookingRecord_(token, record);

    if (config.notifications.emailConfirmation && userEmail) {
      try { sendConfirmation_(config, record, config.management.enabled ? token : '', '예약이 완료되었습니다.'); }
      catch (error) { warnings.push('예약은 완료됐지만 확인 이메일은 보내지 못했습니다.'); }
    }

    const result = {
      ok: true,
      status: warnings.length ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      message: warnings.length ? '예약은 완료됐지만 확인할 사항이 있습니다.' : '예약이 완료되었습니다.',
      roomName: room.name,
      occurrenceCount: dates.length,
      managementToken: config.management.enabled ? token : '',
      warnings
    };
    CacheService.getScriptCache().put(`request:${normalized.requestId}`, JSON.stringify(result), REQUEST_TTL_SECONDS);
    return result;
  } catch (error) {
    return failure_('BOOKING_FAILED', safeErrorMessage_(error), created.events ? rollback_(created.events) : []);
  } finally {
    lock.releaseLock();
  }
}

function getBooking(managementToken) {
  const config = getConfig_();
  if (!config.management.enabled) throw new Error('MANAGEMENT_DISABLED');
  const userEmail = assertAuthorized_(config);
  const record = requireOwnedRecord_(managementToken, userEmail);
  return publicBooking_(record);
}

function cancelBooking(managementToken) {
  const config = getConfig_();
  if (!config.management.enabled) return failure_('MANAGEMENT_DISABLED', '이 조직은 직접 예약 취소 기능을 사용하지 않습니다.');
  const userEmail = assertAuthorized_(config);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return failure_('SERVER_BUSY', '다른 예약을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  try {
    enforceRateLimit_(userEmail || 'anonymous', config);
    const record = requireOwnedRecord_(managementToken, userEmail);
    if (record.status !== 'active') return failure_('NOT_ACTIVE', '이미 취소되었거나 변경할 수 없는 예약입니다.');
    const warnings = deleteEventReferences_(record.events);
    record.status = warnings.length ? 'cancellation_pending' : 'cancelled';
    record.updatedUtc = new Date().toISOString();
    saveBookingRecord_(managementToken, record);
    try { appendManagementLog_(config, 'CANCELLED', record, userEmail); }
    catch (error) { if (config.logging.mode !== 'disabled') warnings.push('취소 결과를 기록 시트에 남기지 못했습니다.'); }
    if (config.notifications.emailConfirmation && userEmail) {
      try { sendConfirmation_(config, record, managementToken, '예약 취소 결과입니다.'); }
      catch (error) { warnings.push('취소 결과 이메일을 보내지 못했습니다.'); }
    }
    return {
      ok: warnings.length === 0,
      status: warnings.length ? 'CANCELLATION_PENDING' : 'CANCELLED',
      message: warnings.length ? '일부 일정을 취소하지 못했습니다. 관리자 확인이 필요합니다.' : '예약을 취소했습니다.',
      warnings
    };
  } catch (error) {
    return failure_('CANCEL_FAILED', safeErrorMessage_(error));
  } finally {
    lock.releaseLock();
  }
}

function rescheduleBooking(managementToken, request) {
  const config = getConfig_();
  if (!config.management.enabled) return failure_('MANAGEMENT_DISABLED', '이 조직은 직접 시간 변경 기능을 사용하지 않습니다.');
  const userEmail = assertAuthorized_(config);
  const normalized = validateRequest_(request, config, true);
  const room = config.rooms.find(item => item.id === normalized.roomId);
  if (!room) return failure_('UNKNOWN_ROOM', '선택한 공간을 찾을 수 없습니다.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return failure_('SERVER_BUSY', '다른 예약을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');

  let created = [];
  try {
    enforceRateLimit_(userEmail || 'anonymous', config);
    const record = requireOwnedRecord_(managementToken, userEmail);
    if (record.status !== 'active') return failure_('NOT_ACTIVE', '이미 취소되었거나 변경할 수 없는 예약입니다.');
    const oldRoomEventIds = record.events.filter(item => item.kind === 'room' && item.calendarId === room.calendarId).map(item => item.eventId);
    const dates = calculateDates_(normalized);
    if (hasAnyConflict_(room.calendarId, dates, normalized.durationMinutes, oldRoomEventIds)) {
      return failure_('ALREADY_BOOKED', '변경하려는 시간에 이미 예약이 있습니다.', [], findAlternatives_(config, normalized, 5));
    }

    created = createBookingEvents_(config, normalized, room, dates, userEmail);
    try { appendLog_(config, 'RESCHEDULED', dates, normalized, room, userEmail); }
    catch (error) {
      if (config.logging.mode === 'required') {
        return failure_('REQUIRED_LOG_FAILED', '필수 기록을 남기지 못해 시간 변경을 취소했습니다.', rollback_(created.events));
      }
      if (config.logging.mode === 'optional') created.warnings.push('변경 내용은 적용됐지만 기록 시트에는 남기지 못했습니다.');
    }

    const deletionWarnings = deleteEventReferences_(record.events);
    const warnings = created.warnings.concat(deletionWarnings);
    record.status = deletionWarnings.length ? 'reschedule_cleanup_pending' : 'active';
    record.updatedUtc = new Date().toISOString();
    record.roomId = room.id;
    record.roomName = room.name;
    record.subject = normalized.subject;
    record.date = normalized.date;
    record.time = normalized.time;
    record.durationMinutes = normalized.durationMinutes;
    record.recurrenceCount = normalized.recurrenceCount;
    record.createMeetingEvent = normalized.createMeetingEvent;
    record.addMeet = normalized.addMeet;
    record.events = created.events.map(toEventReference_);
    saveBookingRecord_(managementToken, record);
    if (config.notifications.emailConfirmation && userEmail) {
      try { sendConfirmation_(config, record, managementToken, '예약 시간이 변경되었습니다.'); }
      catch (error) { warnings.push('변경 결과 이메일을 보내지 못했습니다.'); }
    }
    return {
      ok: deletionWarnings.length === 0,
      status: warnings.length ? 'PARTIAL_SUCCESS' : 'RESCHEDULED',
      message: deletionWarnings.length ? '새 시간으로 변경했지만 이전 일정 일부를 확인해야 합니다.' : '예약 시간을 변경했습니다.',
      booking: publicBooking_(record),
      warnings
    };
  } catch (error) {
    return failure_('RESCHEDULE_FAILED', safeErrorMessage_(error), created.events ? rollback_(created.events) : []);
  } finally {
    lock.releaseLock();
  }
}

function getAdminSummary() {
  const config = getConfig_();
  const userEmail = assertAuthorized_(config);
  if (!config.access.adminEmails.includes(String(userEmail).toLowerCase())) throw new Error('ADMIN_REQUIRED');
  const records = Object.keys(PropertiesService.getScriptProperties().getProperties())
    .filter(key => key.startsWith(BOOKING_PREFIX))
    .map(key => JSON.parse(PropertiesService.getScriptProperties().getProperty(key)));
  return {
    total: records.length,
    active: records.filter(item => item.status === 'active').length,
    cancelled: records.filter(item => item.status === 'cancelled').length,
    attentionRequired: records.filter(item => item.status.includes('pending')).length
  };
}

function purgeExpiredBookingRecords() {
  const config = getConfig_();
  const userEmail = assertAuthorized_(config);
  if (!config.access.adminEmails.includes(String(userEmail).toLowerCase())) throw new Error('ADMIN_REQUIRED');
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  let removed = 0;
  Object.keys(all).filter(key => key.startsWith(BOOKING_PREFIX)).forEach(key => {
    const record = JSON.parse(all[key]);
    if (new Date(record.expiresUtc) < new Date()) {
      properties.deleteProperty(key);
      removed += 1;
    }
  });
  return { removed };
}

function createBookingEvents_(config, request, room, dates, userEmail) {
  const events = [];
  const warnings = [];
  try {
    const roomCalendar = requireCalendar_(room.calendarId, 'ROOM_CALENDAR_UNAVAILABLE');
    dates.forEach(start => {
      const end = new Date(start.getTime() + request.durationMinutes * 60000);
      const event = roomCalendar.createEvent(request.subject, start, end, { description: `Booked by ${userEmail || 'signed-in user'}` });
      events.push({ calendarId: room.calendarId, event, kind: 'room' });
    });
    if (request.createMeetingEvent && config.meetingCalendarId) {
      const meetingCalendar = requireCalendar_(config.meetingCalendarId, 'MEETING_CALENDAR_UNAVAILABLE');
      dates.forEach(start => {
        const end = new Date(start.getTime() + request.durationMinutes * 60000);
        const event = meetingCalendar.createEvent(`${request.subject} @${room.name}`, start, end);
        events.push({ calendarId: config.meetingCalendarId, event, kind: 'meeting' });
        if (request.addMeet) {
          try { addConference_(config.meetingCalendarId, event); }
          catch (error) { warnings.push('일정은 생성됐지만 Google Meet 링크는 만들지 못했습니다.'); }
        }
      });
    }
  } catch (error) {
    rollback_(events);
    throw error;
  }
  return { events, warnings: [...new Set(warnings)] };
}

function findAlternatives_(config, request, limit) {
  const suggestions = [];
  const stepMinutes = 30;
  const maxSteps = config.limits.alternativeSearchDays * 48;
  const searchEnd = new Date(request.start.getTime() + config.limits.alternativeSearchDays * 86400000);
  const roomBusy = config.rooms.map(room => ({
    room,
    events: requireCalendar_(room.calendarId, 'ROOM_CALENDAR_UNAVAILABLE').getEvents(request.start, searchEnd)
  }));
  for (let step = 1; step <= maxSteps && suggestions.length < limit; step += 1) {
    const start = new Date(request.start.getTime() + step * stepMinutes * 60000);
    if (start.getHours() < 7 || start.getHours() >= 22) continue;
    const end = new Date(start.getTime() + request.durationMinutes * 60000);
    const available = roomBusy.filter(item => !item.events.some(event => event.getStartTime() < end && event.getEndTime() > start));
    if (available.length) {
      suggestions.push({
        date: Utilities.formatDate(start, config.timeZone, 'yyyy-MM-dd'),
        time: Utilities.formatDate(start, config.timeZone, 'HH:mm'),
        roomId: available[0].room.id,
        roomName: available[0].room.name
      });
    }
  }
  return suggestions;
}

function getConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_PROPERTY);
  if (!raw) throw new Error('CONFIG_NOT_INSTALLED');
  const config = JSON.parse(raw);
  validateConfig_(config);
  config.access.adminEmails = (config.access.adminEmails || []).map(item => String(item).toLowerCase());
  config.management = Object.assign({ enabled: true, tokenExpiryDays: 30 }, config.management || {});
  config.notifications = Object.assign({ emailConfirmation: false }, config.notifications || {});
  config.limits.alternativeSearchDays = Number(config.limits.alternativeSearchDays || 7);
  config.limits.maxRequestsPerMinute = Number(config.limits.maxRequestsPerMinute || 20);
  return config;
}

function validateConfig_(config) {
  if (!config || !config.appTitle || !Array.isArray(config.rooms) || !config.rooms.length) throw new Error('INVALID_CONFIG');
  const ids = new Set();
  config.rooms.forEach(room => {
    if (!room.id || !room.name || !room.calendarId || ids.has(room.id)) throw new Error('INVALID_CONFIG');
    ids.add(room.id);
  });
  if (!config.logging || !['disabled', 'optional', 'required'].includes(config.logging.mode)) throw new Error('INVALID_CONFIG');
}

function assertAuthorized_(config) {
  if (!config.access || !config.access.requireSignedInUser) return '';
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('AUTH_REQUIRED');
  const domain = email.split('@').pop().toLowerCase();
  const allowed = (config.access.allowedDomains || []).map(item => String(item).toLowerCase());
  if (!allowed.includes(domain)) throw new Error('ACCESS_DENIED');
  return email.toLowerCase();
}

function enforceRateLimit_(identity, config) {
  const key = `rate:${digest_(identity)}`;
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(key) || 0) + 1;
  if (count > config.limits.maxRequestsPerMinute) throw new Error('RATE_LIMITED');
  cache.put(key, String(count), 60);
}

function validateRequest_(request, config, requireRoom) {
  if (!request || typeof request !== 'object') throw new Error('INVALID_REQUEST');
  const start = new Date(`${request.date}T${request.time}:00`);
  if (isNaN(start.getTime())) throw new Error('INVALID_DATE');
  const now = new Date();
  if (start.getTime() < now.getTime() - 60000) throw new Error('PAST_TIME');
  if (start > new Date(now.getTime() + config.limits.maxAdvanceDays * 86400000)) throw new Error('TOO_FAR_AHEAD');
  const duration = Number(request.durationMinutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > config.limits.maxDurationMinutes) throw new Error('INVALID_DURATION');
  const subject = String(request.subject || '').trim();
  if (!subject || subject.length > 120) throw new Error('INVALID_SUBJECT');
  const roomId = String(request.roomId || '');
  if (requireRoom && !roomId) throw new Error('ROOM_REQUIRED');
  const count = request.recurring ? Number(request.recurrenceCount) : 1;
  if (!Number.isInteger(count) || count < 1 || count > config.limits.maxRecurrenceCount) throw new Error('INVALID_RECURRENCE');
  const requestId = String(request.requestId || '');
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('INVALID_REQUEST_ID');
  return {
    start, date: request.date, time: request.time, durationMinutes: duration, subject, roomId,
    recurring: Boolean(request.recurring), recurrenceCount: count,
    createMeetingEvent: Boolean(request.createMeetingEvent),
    addMeet: Boolean(request.createMeetingEvent && request.addMeet), requestId
  };
}

function calculateDates_(request) {
  const dates = [];
  for (let index = 0; index < request.recurrenceCount; index += 1) {
    const date = new Date(request.start);
    date.setDate(date.getDate() + index * 7);
    dates.push(date);
  }
  return dates;
}

function hasAnyConflict_(calendarId, dates, durationMinutes, ignoredEventIds) {
  const calendar = requireCalendar_(calendarId, 'ROOM_CALENDAR_UNAVAILABLE');
  const ignored = new Set(ignoredEventIds || []);
  return dates.some(start => {
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return calendar.getEvents(start, end).some(event => !ignored.has(event.getId()));
  });
}

function requireCalendar_(calendarId, code) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error(code);
  return calendar;
}

function addConference_(calendarId, event) {
  Calendar.Events.patch({ conferenceData: { createRequest: { requestId: Utilities.getUuid() } } }, calendarId, event.getId().split('@')[0], { conferenceDataVersion: 1 });
}

function appendLog_(config, action, dates, request, room, userEmail) {
  if (config.logging.mode === 'disabled') return;
  const sheet = SpreadsheetApp.openById(config.logging.spreadsheetId).getSheets()[0];
  const rows = dates.map(date => [new Date(), action, Utilities.formatDate(date, config.timeZone, 'yyyy-MM-dd HH:mm'), request.durationMinutes, room.name, request.subject, userEmail || '', request.requestId]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function appendManagementLog_(config, action, record, userEmail) {
  if (config.logging.mode === 'disabled') return;
  const sheet = SpreadsheetApp.openById(config.logging.spreadsheetId).getSheets()[0];
  sheet.appendRow([new Date(), action, `${record.date} ${record.time}`, record.durationMinutes, record.roomName, record.subject, userEmail || '', '']);
}

function createManagementToken_() {
  return `${Utilities.getUuid()}${Utilities.getUuid()}`.replace(/-/g, '');
}

function digest_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function saveBookingRecord_(token, record) {
  PropertiesService.getScriptProperties().setProperty(`${BOOKING_PREFIX}${digest_(token)}`, JSON.stringify(record));
}

function requireOwnedRecord_(token, userEmail) {
  if (!/^[A-Za-z0-9]{40,100}$/.test(String(token || ''))) throw new Error('INVALID_MANAGEMENT_TOKEN');
  const raw = PropertiesService.getScriptProperties().getProperty(`${BOOKING_PREFIX}${digest_(token)}`);
  if (!raw) throw new Error('BOOKING_NOT_FOUND');
  const record = JSON.parse(raw);
  if (new Date(record.expiresUtc) < new Date()) throw new Error('MANAGEMENT_TOKEN_EXPIRED');
  if (record.userEmail && String(record.userEmail).toLowerCase() !== String(userEmail).toLowerCase()) throw new Error('BOOKING_NOT_FOUND');
  return record;
}

function publicBooking_(record) {
  return {
    status: record.status, roomName: record.roomName, subject: record.subject,
    date: record.date, time: record.time, durationMinutes: record.durationMinutes,
    recurrenceCount: record.recurrenceCount, createMeetingEvent: record.createMeetingEvent, addMeet: record.addMeet
  };
}

function toEventReference_(item) {
  return { calendarId: item.calendarId, eventId: item.event.getId(), kind: item.kind };
}

function deleteEventReferences_(references) {
  const warnings = [];
  (references || []).forEach(reference => {
    try {
      const calendar = requireCalendar_(reference.calendarId, 'CALENDAR_UNAVAILABLE');
      const event = calendar.getEventById(reference.eventId);
      if (event) event.deleteEvent();
    } catch (error) {
      warnings.push('일부 일정을 자동으로 처리하지 못했습니다. 관리자에게 확인해 주세요.');
    }
  });
  return [...new Set(warnings)];
}

function rollback_(events) {
  return deleteEventReferences_((events || []).map(toEventReference_));
}

function sendConfirmation_(config, record, token, heading) {
  const url = ScriptApp.getService().getUrl() || '';
  const managementLine = token ? `예약 관리 번호: ${token}` : '';
  const body = [heading, '', `공간: ${record.roomName}`, `일시: ${record.date} ${record.time}`, `예약 목적: ${record.subject}`, `반복 횟수: ${record.recurrenceCount}`, '', managementLine, url ? `예약 페이지: ${url}` : ''].filter(Boolean).join('\n');
  MailApp.sendEmail(record.userEmail, `[${config.appTitle}] ${heading}`, body);
}

function safeErrorMessage_(error) {
  const code = String(error && error.message || error || '');
  const messages = {
    RATE_LIMITED: '요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.',
    BOOKING_NOT_FOUND: '예약을 찾을 수 없습니다. 관리 번호와 로그인 계정을 확인해 주세요.',
    MANAGEMENT_TOKEN_EXPIRED: '예약 관리 기간이 지났습니다. 관리자에게 문의해 주세요.',
    INVALID_MANAGEMENT_TOKEN: '예약 관리 번호의 형식이 올바르지 않습니다.',
    AUTH_REQUIRED: '회사 Google 계정으로 로그인해 주세요.',
    ACCESS_DENIED: '이 조직의 계정으로만 이용할 수 있습니다.'
  };
  return messages[code] || '요청을 완료하지 못했습니다. 입력 내용과 권한을 확인해 주세요.';
}

function failure_(code, message, warnings, alternatives) {
  return { ok: false, status: code, message, warnings: warnings || [], alternatives: alternatives || [] };
}
