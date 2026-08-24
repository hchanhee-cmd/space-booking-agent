const CONFIG_PROPERTY = 'SPACE_BOOKING_CONFIG';

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
    meetAvailable: Boolean(config.meetingCalendarId)
  };
}

function checkInstallation() {
  const config = getConfig_();
  const checks = [];
  config.rooms.forEach(room => {
    const calendar = CalendarApp.getCalendarById(room.calendarId);
    checks.push({ item: `Room: ${room.name}`, ok: Boolean(calendar) });
  });
  if (config.meetingCalendarId) {
    checks.push({
      item: 'Meeting calendar',
      ok: Boolean(CalendarApp.getCalendarById(config.meetingCalendarId))
    });
  }
  if (config.logging.mode !== 'disabled') {
    let logOk = false;
    try {
      logOk = Boolean(SpreadsheetApp.openById(config.logging.spreadsheetId));
    } catch (error) {
      logOk = false;
    }
    checks.push({ item: 'Reservation log', ok: logOk });
  }
  return { ok: checks.every(check => check.ok), checks };
}

function getAvailableRooms(request) {
  const config = getConfig_();
  assertAuthorized_(config);
  const normalized = validateRequest_(request, config, false);
  const dates = calculateDates_(normalized, config);
  return config.rooms
    .filter(room => !hasAnyConflict_(room.calendarId, dates, normalized.durationMinutes))
    .map(room => ({ id: room.id, name: room.name }));
}

function bookRoom(request) {
  const config = getConfig_();
  const userEmail = assertAuthorized_(config);
  const normalized = validateRequest_(request, config, true);
  const room = config.rooms.find(item => item.id === normalized.roomId);
  if (!room) return failure_('UNKNOWN_ROOM', '선택한 공간을 찾을 수 없습니다.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return failure_('SERVER_BUSY', '다른 예약을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  }

  const created = [];
  const warnings = [];
  try {
    const duplicate = CacheService.getScriptCache().get(`request:${normalized.requestId}`);
    if (duplicate) return JSON.parse(duplicate);

    const dates = calculateDates_(normalized, config);
    if (hasAnyConflict_(room.calendarId, dates, normalized.durationMinutes)) {
      return failure_('ALREADY_BOOKED', '선택한 시간에 이미 예약이 있습니다.');
    }

    const roomCalendar = requireCalendar_(room.calendarId, 'ROOM_CALENDAR_UNAVAILABLE');
    dates.forEach(start => {
      const end = new Date(start.getTime() + normalized.durationMinutes * 60000);
      const event = roomCalendar.createEvent(normalized.subject, start, end, {
        description: `Booked by ${userEmail || 'signed-in user'}`
      });
      created.push({ calendar: roomCalendar, event, kind: 'room' });
    });

    if (normalized.createMeetingEvent && config.meetingCalendarId) {
      const meetingCalendar = requireCalendar_(config.meetingCalendarId, 'MEETING_CALENDAR_UNAVAILABLE');
      dates.forEach(start => {
        const end = new Date(start.getTime() + normalized.durationMinutes * 60000);
        const event = meetingCalendar.createEvent(`${normalized.subject} @${room.name}`, start, end);
        created.push({ calendar: meetingCalendar, event, kind: 'meeting' });
        if (normalized.addMeet) {
          try {
            addConference_(meetingCalendar.getId(), event);
          } catch (error) {
            warnings.push('일정은 생성됐지만 Google Meet 링크는 만들지 못했습니다.');
          }
        }
      });
    }

    try {
      appendLog_(config, dates, normalized, room, userEmail);
    } catch (error) {
      if (config.logging.mode === 'required') {
        const rollbackWarnings = rollback_(created);
        return failure_(
          'REQUIRED_LOG_FAILED',
          '필수 예약 기록을 남기지 못해 새 예약을 되돌렸습니다.',
          rollbackWarnings
        );
      }
      if (config.logging.mode === 'optional') {
        warnings.push('예약은 완료됐지만 예약 기록 시트에는 남기지 못했습니다.');
      }
    }

    const result = {
      ok: true,
      status: warnings.length ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      message: warnings.length ? '예약은 완료됐지만 확인할 사항이 있습니다.' : '예약이 완료되었습니다.',
      roomName: room.name,
      occurrenceCount: dates.length,
      warnings
    };
    CacheService.getScriptCache().put(`request:${normalized.requestId}`, JSON.stringify(result), 600);
    return result;
  } catch (error) {
    const rollbackWarnings = rollback_(created);
    return failure_('BOOKING_FAILED', '예약을 완료하지 못했습니다. 새로 만들어진 일정은 되돌렸습니다.', rollbackWarnings);
  } finally {
    lock.releaseLock();
  }
}

function getConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_PROPERTY);
  if (!raw) throw new Error('CONFIG_NOT_INSTALLED');
  const config = JSON.parse(raw);
  validateConfig_(config);
  return config;
}

function validateConfig_(config) {
  if (!config || !config.appTitle || !Array.isArray(config.rooms) || !config.rooms.length) {
    throw new Error('INVALID_CONFIG');
  }
  const ids = new Set();
  config.rooms.forEach(room => {
    if (!room.id || !room.name || !room.calendarId || ids.has(room.id)) throw new Error('INVALID_CONFIG');
    ids.add(room.id);
  });
  if (!config.logging || !['disabled', 'optional', 'required'].includes(config.logging.mode)) {
    throw new Error('INVALID_CONFIG');
  }
}

function assertAuthorized_(config) {
  if (!config.access || !config.access.requireSignedInUser) return '';
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('AUTH_REQUIRED');
  const domain = email.split('@').pop().toLowerCase();
  const allowed = (config.access.allowedDomains || []).map(item => String(item).toLowerCase());
  if (!allowed.includes(domain)) throw new Error('ACCESS_DENIED');
  return email;
}

function validateRequest_(request, config, requireRoom) {
  if (!request || typeof request !== 'object') throw new Error('INVALID_REQUEST');
  const start = new Date(`${request.date}T${request.time}:00`);
  if (isNaN(start.getTime())) throw new Error('INVALID_DATE');
  const now = new Date();
  if (start.getTime() < now.getTime() - 60000) throw new Error('PAST_TIME');
  const maxDate = new Date(now.getTime() + config.limits.maxAdvanceDays * 86400000);
  if (start > maxDate) throw new Error('TOO_FAR_AHEAD');
  const duration = Number(request.durationMinutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > config.limits.maxDurationMinutes) {
    throw new Error('INVALID_DURATION');
  }
  const subject = String(request.subject || '').trim();
  if (!subject || subject.length > 120) throw new Error('INVALID_SUBJECT');
  const roomId = String(request.roomId || '');
  if (requireRoom && !roomId) throw new Error('ROOM_REQUIRED');
  const count = request.recurring ? Number(request.recurrenceCount) : 1;
  if (!Number.isInteger(count) || count < 1 || count > config.limits.maxRecurrenceCount) {
    throw new Error('INVALID_RECURRENCE');
  }
  const requestId = String(request.requestId || '');
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('INVALID_REQUEST_ID');
  return {
    start,
    date: request.date,
    time: request.time,
    durationMinutes: duration,
    subject,
    roomId,
    recurring: Boolean(request.recurring),
    recurrenceCount: count,
    createMeetingEvent: Boolean(request.createMeetingEvent),
    addMeet: Boolean(request.createMeetingEvent && request.addMeet),
    requestId
  };
}

function calculateDates_(request, config) {
  const dates = [];
  for (let index = 0; index < request.recurrenceCount; index += 1) {
    const date = new Date(request.start);
    date.setDate(date.getDate() + index * 7);
    dates.push(date);
  }
  return dates;
}

function hasAnyConflict_(calendarId, dates, durationMinutes) {
  const calendar = requireCalendar_(calendarId, 'ROOM_CALENDAR_UNAVAILABLE');
  return dates.some(start => {
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return calendar.getEvents(start, end).length > 0;
  });
}

function requireCalendar_(calendarId, code) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error(code);
  return calendar;
}

function addConference_(calendarId, event) {
  const eventId = event.getId().split('@')[0];
  Calendar.Events.patch({
    conferenceData: { createRequest: { requestId: Utilities.getUuid() } }
  }, calendarId, eventId, { conferenceDataVersion: 1 });
}

function appendLog_(config, dates, request, room, userEmail) {
  if (config.logging.mode === 'disabled') return;
  const sheet = SpreadsheetApp.openById(config.logging.spreadsheetId).getSheets()[0];
  const rows = dates.map(date => [
    new Date(),
    Utilities.formatDate(date, config.timeZone, 'yyyy-MM-dd HH:mm'),
    request.durationMinutes,
    room.name,
    request.subject,
    userEmail || '',
    request.requestId
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function rollback_(created) {
  const warnings = [];
  created.slice().reverse().forEach(item => {
    try {
      item.event.deleteEvent();
    } catch (error) {
      warnings.push('일부 일정은 자동으로 되돌리지 못했습니다. 캘린더에서 확인해 주세요.');
    }
  });
  return [...new Set(warnings)];
}

function failure_(code, message, warnings) {
  return { ok: false, status: code, message, warnings: warnings || [] };
}
