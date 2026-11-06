'use strict';

const byId = (id) => document.getElementById(id);
const options = window.strengthConfig ?? {};
const configReady = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(options.url) &&
  /^sb_publishable_[A-Za-z0-9_-]+$/.test(options.publishableKey);
const params = new URLSearchParams(location.hash.slice(1));
const room = params.get('room');
const admin = params.get('admin');
const isUuid = (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const iso = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
});
const fullDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});
const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', weekday: 'short' });
const parseDay = (value) => new Date(value + 'T00:00:00Z');

function koreaToday() {
  const parts = Object.fromEntries(iso.formatToParts().map(({ type, value }) => [type, value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function showDate(day) {
  byId('header-date').dateTime = day;
  byId('header-date').textContent = fullDate.format(parseDay(day));
}

async function rpc(action, body) {
  const response = await fetch(options.url.replace(/\/$/, '') + '/rest/v1/rpc/strength_' + action, {
    method: 'POST',
    headers: { apikey: options.publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.message || 'Request failed');
    error.code = detail.code;
    throw error;
  }
  return response.json();
}

function startParticipants() {
  const table = byId('roster-table');
  const scroll = byId('roster-scroll');
  const rosterStatus = byId('roster-status');
  const sharedHint = byId('shared-hint');
  const collator = new Intl.Collator('ko-KR', { numeric: true });
  let snapshot = null;
  let signature = '';
  let pending = false;
  let writing = false;
  let revision = 0;
  let firstTable = true;

  function show(data) {
    const nextSignature = JSON.stringify(data);
    if (signature === nextSignature) return;
    snapshot = data;
    signature = nextSignature;

    showDate(data.today);
    const today = parseDay(data.today);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - 6 + index);
      return { date, key: date.toISOString().slice(0, 10) };
    });
    const excluded = new Set(data.excluded);
    const members = [...data.members].sort((a, b) => collator.compare(a.name, b.name));
    const doneToday = excluded.has(data.today) ? [] : members.filter((member) => member.days.includes(data.today));
    const activeButton = document.activeElement;
    const restoreFocus = table.contains(activeButton) ? activeButton.dataset : null;
    let nextFocus;

    const header = document.createElement('tr');
    const nameHeader = document.createElement('th');
    nameHeader.scope = 'col';
    nameHeader.textContent = '이름';
    header.append(nameHeader);
    for (const { date, key } of days) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      const dayLabel = (date.getUTCMonth() + 1) + '/' + date.getUTCDate();
      cell.textContent = dayLabel;
      const sub = document.createElement('span');
      sub.textContent = excluded.has(key) ? '제외' : key === data.today ? '오늘' : weekday.format(date);
      cell.append(sub);
      if (key === data.today) cell.classList.add('current');
      header.append(cell);
    }
    byId('roster-head').replaceChildren(header);

    const rows = document.createDocumentFragment();
    for (const member of members) {
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = member.name;
      row.append(name);
      for (const { date, key } of days) {
        const cell = document.createElement('td');
        if (key === data.today) cell.classList.add('current');
        const label = member.name + ', ' + fullDate.format(date);
        if (excluded.has(key)) {
          cell.classList.add('skipped');
          const mark = document.createElement('span');
          mark.textContent = '–';
          mark.setAttribute('aria-label', label + ', 제외일');
          cell.append(mark);
        } else {
          const button = document.createElement('button');
          const done = member.days.includes(key);
          button.type = 'button';
          button.className = 'cell-check';
          button.textContent = done ? '✓' : '○';
          button.setAttribute('aria-label', label + ' 운동 완료');
          button.setAttribute('aria-pressed', String(done));
          button.dataset.member = member.id;
          button.dataset.day = key;
          button.addEventListener('click', () => { void setCheck(member.id, key, !done); });
          if (restoreFocus?.member === member.id && restoreFocus?.day === key) nextFocus = button;
          cell.append(button);
        }
        row.append(cell);
      }
      rows.append(row);
    }
    byId('roster-body').replaceChildren(rows);
    scroll.hidden = !members.length;
    if (members.length && firstTable) {
      scroll.scrollLeft = scroll.scrollWidth;
      firstTable = false;
    }
    if (nextFocus) nextFocus.focus({ preventScroll: true });

    byId('roster-hint').textContent = members.length
      ? data.room + ' · 내 이름의 날짜 칸을 누르세요. 한 번 더 누르면 취소돼요.'
      : data.room + ' · 관리자가 명단을 등록하면 여기에 표시돼요.';
    sharedHint.textContent = excluded.has(data.today) ? '오늘은 제외일이에요.'
      : doneToday.length ? data.room + ' · 같은 반 참가자와 공유되는 명단이에요.'
      : '아직 오늘 체크한 사람이 없어요.';
    byId('shared-count').hidden = excluded.has(data.today);
    byId('shared-count').textContent = doneToday.length + '명 완료';
    byId('shared-names').replaceChildren(...doneToday.map((member) => {
      const item = document.createElement('li');
      item.textContent = member.name;
      return item;
    }));
  }

  async function refresh() {
    if (writing || pending) return;
    pending = true;
    const requested = revision;
    try {
      const data = await rpc('roster_snapshot', { p_room: room });
      if (requested === revision) show(data);
    } catch (error) {
      if (requested === revision && !snapshot) {
        byId('roster-hint').textContent = error.code === 'P0002'
          ? '이 반을 찾을 수 없어요. 초대 링크를 확인해 주세요.'
          : '명단에 연결할 수 없어요. 잠시 후 다시 연결합니다.';
      }
    } finally {
      pending = false;
    }
  }

  async function setCheck(member, day, done) {
    if (writing) return;
    writing = true;
    revision++;
    table.setAttribute('aria-busy', 'true');
    try {
      const data = await rpc('roster_set_check', { p_room: room, p_member: member, p_day: day, p_done: done });
      show(data);
      rosterStatus.textContent = done ? '선택한 날짜에 완료를 기록했어요.' : '선택한 날짜의 체크를 취소했어요.';
    } catch (error) {
      rosterStatus.textContent = error.code === '22023'
        ? '이 칸은 지금 체크할 수 없어요. 최신 명단을 확인해 주세요.'
        : '변경을 확인할 수 없어요. 연결을 확인하고 다시 눌러 주세요.';
    } finally {
      writing = false;
      table.setAttribute('aria-busy', 'false');
      void refresh();
    }
  }

  byId('roster').hidden = false;
  byId('shared').hidden = false;
  byId('storage-note').textContent = '같은 반 링크를 가진 참가자에게 명단과 체크 기록이 보여요. 본인 칸만 체크해 주세요.';
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) void refresh(); });
}

function startAdmin() {
  const login = byId('admin-login');
  const controls = byId('admin-controls');
  const passwordInput = byId('password');
  const rosterInput = byId('roster-input');
  const picker = byId('exclude-day');
  const status = byId('admin-status');
  let password = '';
  let busy = false;
  byId('admin').hidden = false;
  byId('storage-note').textContent = '관리자 링크는 관리자만 보관해 주세요.';

  function showRoster(members) {
    byId('roster-size').textContent = members.length + '명';
    byId('admin-roster-empty').hidden = Boolean(members.length);
    byId('admin-roster-list').replaceChildren(...members.map((member) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = member.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'change';
      remove.textContent = '명단에서 빼기';
      remove.setAttribute('aria-label', member.name + ' 명단에서 빼기');
      remove.addEventListener('click', () => { void changeRoster(null, member.id); });
      row.append(name, remove);
      return row;
    }));
  }

  function showDays(data) {
    picker.value ||= data.today;
    byId('excluded-empty').hidden = Boolean(data.excluded.length);
    byId('excluded-list').replaceChildren(...data.excluded.map((day) => {
      const row = document.createElement('li');
      const label = document.createElement('time');
      label.dateTime = day;
      label.textContent = fullDate.format(parseDay(day));
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'change';
      restore.textContent = '제외 해제';
      restore.setAttribute('aria-label', label.textContent + ' 제외 해제');
      restore.addEventListener('click', () => { void changeDay(day, false); });
      row.append(label, restore);
      return row;
    }));
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    const buttons = Array.from(byId('admin').querySelectorAll('button'));
    buttons.forEach((button) => { button.disabled = true; });
    status.textContent = '';
    try {
      await action();
    } catch (error) {
      if (!login.hidden) {
        password = '';
        passwordInput.focus();
      }
      status.textContent = error.code === '28000'
        ? '관리자 링크 또는 비밀번호를 확인해 주세요.'
        : '요청을 처리할 수 없어요. 연결을 확인하고 다시 시도해 주세요.';
    } finally {
      busy = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  const manageDays = (day, excluded) => rpc('manage_days', {
    p_admin: admin, p_password: password, p_day: day, p_excluded: excluded
  });
  const manageRoster = (names, remove) => rpc('manage_roster', {
    p_admin: admin, p_password: password, p_names: names, p_remove: remove
  });

  function changeDay(day, exclude) {
    return run(async () => {
      showDays(await manageDays(day, exclude));
      status.textContent = exclude ? '선택한 날짜를 제외했어요.' : '선택한 날짜의 제외를 해제했어요.';
      picker.focus();
    });
  }

  function changeRoster(names, remove) {
    return run(async () => {
      showRoster(await manageRoster(names, remove));
      if (names) rosterInput.value = '';
      status.textContent = names ? '명단을 등록했어요.' : '선택한 이름을 명단에서 뺐어요.';
      rosterInput.focus();
    });
  }

  login.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    password = passwordInput.value;
    passwordInput.value = '';
    void run(async () => {
      const data = await manageDays(null, null);
      const members = await manageRoster(null, null);
      login.hidden = true;
      controls.hidden = false;
      byId('admin-hint').textContent = data.room + ' · 명단을 등록한 뒤 참가자 링크를 공유하세요.';
      byId('participant-link').href = '#room=' + data.roomId;
      showRoster(members);
      showDays(data);
      status.textContent = '로그인했어요.';
      rosterInput.focus();
    });
  });

  byId('roster-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const names = [...new Set(rosterInput.value.split(/\r?\n/)
      .map((name) => name.normalize('NFC').trim().replace(/[^\S\n\r]+/g, ' ')).filter(Boolean))];
    if (!names.length || names.length > 100 || names.some((name) => [...name].length > 30 || /[\x00-\x1f\x7f]/.test(name))) {
      status.textContent = '한 줄에 30자 이하의 이름을 한 명씩 적어 주세요. 한 번에 100명까지 등록할 수 있어요.';
      rosterInput.focus();
      return;
    }
    void changeRoster(names, null);
  });
  byId('exclude-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void changeDay(picker.value, true);
  });
  byId('logout').addEventListener('click', () => {
    password = '';
    controls.hidden = true;
    login.hidden = false;
    picker.value = '';
    rosterInput.value = '';
    byId('participant-link').removeAttribute('href');
    byId('excluded-list').replaceChildren();
    byId('admin-roster-list').replaceChildren();
    byId('admin-hint').textContent = '관리자 비밀번호를 입력해 주세요.';
    status.textContent = '로그아웃했어요.';
    passwordInput.focus();
  });
}

showDate(koreaToday());
if (configReady && isUuid(admin)) {
  startAdmin();
} else if (configReady && isUuid(room) && !admin) {
  startParticipants();
} else {
  byId('shared').hidden = false;
  byId('shared-heading').textContent = configReady ? '우리 반 링크로 접속해 주세요' : '공용 기록 연결이 필요해요';
  byId('shared-hint').textContent = configReady
    ? '관리자가 공유한 참가자 링크를 열면 오늘의 운동을 체크할 수 있어요.'
    : '관리자는 README.md의 순서대로 공용 저장소를 연결해 주세요.';
}
window.addEventListener('hashchange', () => location.reload());


