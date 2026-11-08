import type { Article, Decision, Item } from '../types';
import type { Repo } from './repo';
import { mockJudge } from '../lib/mockJudge';
import sample from './sample.json';

const LS_KEY = 'prt-decisions-v1';

function toItem(a: Article): Item {
  return { ...a, ts: new Date(a.publishedAt).getTime(), judge: a.ai ?? mockJudge(a) };
}

/** 負荷テスト用：実データを複製し、直近2日間に各3,000件をばらす */
function stress(base: Item[]): Item[] {
  const out: Item[] = [];
  const now = new Date();
  let n = 0;
  for (let day = 0; day < 2; day++) {
    const d0 = new Date(now);
    d0.setDate(d0.getDate() - day);
    d0.setHours(0, 0, 0, 0);
    for (let k = 0; k < 3000; k++) {
      const b = base[n % base.length];
      n++;
      const u = Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1);
      const hour = 8 + Math.floor(u * u * 13.99);
      const min = Math.floor(Math.abs((Math.sin(n * 78.233) * 12345.678) % 1) * 60);
      out.push({ ...b, id: `s${day}-${k}`, ts: d0.getTime() + hour * 3600e3 + min * 60e3 });
    }
  }
  return out;
}

export function createMockRepo(opts: { stress?: boolean } = {}): Repo {
  const loadDecisions = (): Record<string, Decision> => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, Decision>;
    } catch {
      return {};
    }
  };
  return {
    subscribe(onData) {
      const base = (sample as Article[]).map(toItem);
      const items = (opts.stress ? stress(base) : base).sort((a, b) => b.ts - a.ts);
      const t = setTimeout(() => onData({ items, decisions: loadDecisions() }), 0);
      return () => clearTimeout(t);
    },
    async saveDecisions(changes) {
      try {
        const cur = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, Decision>;
        for (const [id, d] of Object.entries(changes)) {
          if (d) cur[id] = d;
          else delete cur[id];
        }
        localStorage.setItem(LS_KEY, JSON.stringify(cur));
      } catch {
        /* 保存できない環境（プライベートブラウズ等）では画面上だけ反映 */
      }
    },
  };
}
