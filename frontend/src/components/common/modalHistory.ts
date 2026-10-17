// 모달 "뒤로가기로 닫기"의 history 조작 관리자 (D-029).
//
// 모달마다 hash 기록(`#modal-<id>`)을 하나씩 push 하고, 브라우저/폰 뒤로가기로 그 기록이 사라지면 닫는다.
// 여러 모달이 동시에 열고 닫혀도 기록이 꼬이지 않도록 다음을 지킨다.
//  - 판정은 hash 가 아니라 react-router 가 기록마다 붙이는 `history.state.idx` 로 한다.
//    (모달이 열린 채 setSearchParams 등으로 hash 가 지워져도 내 기록을 찾을 수 있다.)
//  - push·회수를 모듈 큐로 직렬화한다. `history.back()` 은 비동기라, 닫힌 모달의 회수가 끝나기 전에
//    다음 모달이 push 하면 그 기록이 대신 지워져 새 모달이 즉시 닫히던 문제가 있었다.
//  - 회수는 "현재 기록이 내 기록 또는 그 위의 닫힌 모달 기록이고, 화면(pathname)이 그대로"일 때만 한다.
//    닫자마자 다른 화면으로 이동했다면 회수하지 않고, 남은 기록은 고아 건너뛰기가 처리한다.
//  - 고아 기록: 뒤로/앞으로 이동해 도착한 기록이 모달 hash 인데 그 기록을 가진 열린 모달이 없으면
//    같은 방향으로 한 칸 더 이동한다(예: 모달을 닫고 바로 이동한 화면에서 뒤로가기).

export const MODAL_HASH_PREFIX = '#modal-';
const MODAL_HASH_RE = /^#modal-[A-Za-z0-9]+$/;
const POP_TIMEOUT_MS = 500;

interface Entry {
  idx: number;
  path: string;
  /** 사용자 뒤로가기로 기록이 사라졌을 때 — 모달의 onClose. */
  close: () => void;
  /** close 뒤에도 열려 있으면(실행 중이라 닫기를 막는 모달) 기록을 다시 push 한다. */
  stillOpen: () => boolean;
  repush: () => void;
}

const entries = new Map<symbol, Entry>();
/** 닫혔지만 위에 열린 모달이 남아 있어 회수를 미룬 기록 — 그 모달이 닫힐 때 함께 회수한다. */
const deferred: { idx: number; path: string }[] = [];
let queue: Promise<void> = Promise.resolve();
let selfPops = 0;
let lastIdx = 0;
let installed = false;

export function currentIdx(): number {
  const s = window.history.state as { idx?: unknown } | null;
  return typeof s?.idx === 'number' ? s.idx : 0;
}

function enqueue(op: () => void | Promise<void>): void {
  queue = queue.then(op).catch(() => undefined);
}

/** 우리가 일으키는 이동 — popstate 를 기다린다(오지 않으면 타임아웃). 사용자 이동으로 오인하지 않게 표시한다. */
function selfGo(delta: number): Promise<void> {
  return new Promise((resolve) => {
    selfPops += 1;
    const done = () => {
      window.removeEventListener('popstate', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      selfPops = Math.max(0, selfPops - 1);
      done();
    }, POP_TIMEOUT_MS);
    window.addEventListener('popstate', done);
    window.history.go(delta);
  });
}

function onPopState() {
  const idx = currentIdx();
  if (selfPops > 0) {
    selfPops -= 1;
    lastIdx = idx;
    return;
  }
  const wentBack = idx < lastIdx;
  lastIdx = idx;

  // 사용자 뒤로가기로 기록이 사라진 모달을 닫는다(위에 있는 것부터).
  const gone = [...entries.entries()].filter(([, e]) => e.idx > idx).sort((a, b) => b[1].idx - a[1].idx);
  for (const [key, e] of gone) {
    entries.delete(key);
    e.close();
    setTimeout(() => { if (e.stillOpen()) e.repush(); }, 0);
  }

  // 고아 모달 기록에 도착했으면 같은 방향으로 한 칸 더.
  if (MODAL_HASH_RE.test(window.location.hash) && ![...entries.values()].some((e) => e.idx === idx)) {
    enqueue(() => selfGo(wentBack ? -1 : 1));
  }
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  lastIdx = currentIdx();
  window.addEventListener('popstate', onPopState);
}

/**
 * 모달 기록을 push 한다. `push` 는 react-router navigate 로 hash 를 붙이는 함수(라우터 상태·idx 를 맞춘다).
 * 반환한 `release` 는 모달이 닫히거나 언마운트될 때 부른다 — 기록이 남아 있으면 회수한다.
 */
export function openModalEntry(
  push: () => void,
  handlers: Pick<Entry, 'close' | 'stillOpen'>,
): () => void {
  install();
  const key = Symbol('modal');
  let released = false;

  const doPush = () => enqueue(() => {
    if (released) return;
    push();
    const idx = currentIdx();
    lastIdx = idx;
    entries.set(key, { idx, path: window.location.pathname, ...handlers, repush: doPush });
  });
  doPush();

  return () => {
    released = true;
    const e = entries.get(key);
    if (!e) return; // 아직 push 전이거나, 사용자 뒤로가기로 이미 사라졌다
    entries.delete(key);
    enqueue(async () => {
      const cur = currentIdx();
      if (window.location.pathname !== e.path || cur < e.idx) return;
      // 내 기록 위에 열린 모달 기록이 있으면 지금은 건드리지 않는다(그 모달이 닫힐 때 함께 회수).
      if ([...entries.values()].some((o) => o.idx > e.idx && o.idx <= cur)) {
        deferred.push({ idx: e.idx, path: e.path });
        return;
      }
      // 바로 아래에 회수를 미뤄 둔 기록이 이어져 있으면 한 번에 회수한다.
      let low = e.idx;
      for (let i = deferred.findIndex((d) => d.idx === low - 1 && d.path === e.path); i >= 0;
        i = deferred.findIndex((d) => d.idx === low - 1 && d.path === e.path)) {
        low -= 1;
        deferred.splice(i, 1);
      }
      await selfGo(-(cur - low + 1));
    });
  };
}

/** 새로고침 등으로 모달 hash 가 남은 채 열린 경우 주소창에서만 지운다(기록 수는 그대로). */
export function stripStaleModalHash() {
  if (typeof window === 'undefined' || !MODAL_HASH_RE.test(window.location.hash)) return;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);
}
