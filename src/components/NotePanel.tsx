import { useEffect, useRef, useState } from 'react';
import type { Item, Status } from '../types';
import {
  MAX_RECORD_SEC,
  refreshHandoff,
  requestDraft,
  saveNote,
  startRecording,
  subscribeDraft,
  subscribeNote,
  transcribe,
  type Draft,
  type Note,
} from '../lib/notes';

/**
 * 「読む」「読了」の記事に付く、AI の下書き（要点・営業の切り口・相性のよいサービス）と自分のメモ。
 * メモは AI の下書きから始まり、直したり、話して足したりできる。読了の記事は Knowledge Base に渡る。
 */
export function NotePanel({ it, status }: { it: Item; status: Status }) {
  const [draft, setDraft] = useState<Draft | null | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [tagInput, setTagInput] = useState('');
  const [rec, setRec] = useState<'idle' | 'recording' | 'working' | 'error'>('idle');
  const [recErr, setRecErr] = useState('');
  const [sec, setSec] = useState(0);
  const stopRef = useRef<(() => Promise<string>) | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    setDraft(undefined);
    setNote(undefined);
    setText('');
    setDirty(false);
    setSaving('idle');
    const u1 = subscribeDraft(it.id, setDraft);
    const u2 = subscribeNote(it.id, setNote);
    return () => {
      u1();
      u2();
    };
  }, [it.id]);

  // メモの初期値：保存したメモ → なければ AI の下書き（直していないあいだは下書きが届いたら入れる）
  useEffect(() => {
    if (dirty || note === undefined) return;
    setText(note.memo ?? (draft?.state === 'done' ? draft.memo ?? '' : ''));
  }, [note, draft, dirty]);

  const save = async (patch: Note) => {
    setSaving('saving');
    try {
      await saveNote(it.id, patch);
      setSaving('saved');
      if (status === 'done') void refreshHandoff(it.id);
    } catch {
      setSaving('error');
    }
  };
  const saveMemo = async (memo = textRef.current) => {
    await save({ memo });
    setDirty(false);
  };

  const myTags = note?.myTags ?? [];
  const stars = note?.stars ?? 0;
  const addTag = () => {
    const tags = tagInput
      .split(/[、,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tags.length) return;
    setTagInput('');
    void save({ myTags: [...new Set([...myTags, ...tags])].slice(0, 20) });
  };

  // 録音：最大55秒。止めたら文字に起こし、整えた文をメモの最後に足す
  useEffect(() => {
    if (rec !== 'recording') return;
    const t0 = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setSec(s);
      if (s >= MAX_RECORD_SEC) void stopRec();
    }, 250);
    return () => clearInterval(timer);
  }, [rec]); // eslint-disable-line react-hooks/exhaustive-deps
  const startRec = async () => {
    setRecErr('');
    try {
      const r = await startRecording();
      stopRef.current = r.stop;
      setSec(0);
      setRec('recording');
    } catch (e) {
      setRec('error');
      setRecErr(e instanceof Error && e.name === 'NotAllowedError' ? 'マイクの使用が許可されていません（設定 → Safari → マイク）' : 'マイクを使えませんでした');
    }
  };
  const stopRec = async () => {
    const stop = stopRef.current;
    if (!stop) return;
    stopRef.current = null;
    setRec('working');
    try {
      const wav = await stop();
      const r = await transcribe(wav, { title: it.title, company: it.company });
      if (!r.text) {
        setRec('error');
        setRecErr('声を聞き取れませんでした。もう一度お試しください');
        return;
      }
      const cur = textRef.current.trim();
      const next = cur ? `${cur}\n${r.text}` : r.text;
      setText(next);
      setRec('idle');
      await saveMemo(next);
    } catch (e) {
      setRec('error');
      setRecErr(`文字起こしに失敗しました（${e instanceof Error ? e.message : String(e)}）`);
    }
  };

  const d = draft?.state === 'done' ? draft : null;
  return (
    <section className="notepanel" aria-label="営業メモ">
      <div className="nphead">
        <b>営業メモ</b>
        <span className="stars" role="group" aria-label="重要度">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={stars >= n}
              aria-label={`重要度${n}`}
              onClick={() => void save({ stars: stars === n ? 0 : n })}
            >
              {stars >= n ? '★' : '☆'}
            </button>
          ))}
        </span>
      </div>

      <div className="memobox">
        <textarea
          value={text}
          rows={5}
          placeholder={draft?.state === 'working' || draft === undefined ? 'AIが下書きを作っています…' : 'なぜ大事か、次に何をするか'}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            setSaving('idle');
          }}
          onBlur={() => dirty && void saveMemo()}
        />
        <div className="memoacts">
          {rec === 'recording' ? (
            <button className="btn rec on" type="button" onClick={() => void stopRec()}>
              ■ 止める（{MAX_RECORD_SEC - sec}秒）
            </button>
          ) : (
            <button className="btn rec" type="button" onClick={() => void startRec()} disabled={rec === 'working'}>
              {rec === 'working' ? '文字にしています…' : '🎤 話して足す'}
            </button>
          )}
          <button className="btn" type="button" onClick={() => void saveMemo()} disabled={!dirty}>
            保存
          </button>
          <span className="muted small">
            {saving === 'saving' ? '保存中…' : saving === 'saved' ? '保存しました' : saving === 'error' ? '保存できませんでした' : note?.memo === undefined && d ? 'AIの下書きです。直して保存できます' : ''}
          </span>
        </div>
        {rec === 'error' && <div className="small err">{recErr}</div>}
      </div>

      <div className="mytags">
        {myTags.map((tg) => (
          <button key={tg} className="chip" type="button" aria-label={`${tg} を外す`} onClick={() => void save({ myTags: myTags.filter((x) => x !== tg) })}>
            {tg} ×
          </button>
        ))}
        <input
          value={tagInput}
          placeholder="自分用タグ（例：競合、提案ネタ）"
          aria-label="自分用タグ"
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
        />
      </div>

      {draft === undefined || draft?.state === 'working' ? (
        <div className="summary muted small">AIが記事を読んで、要点と営業の切り口をまとめています（1分ほど）…</div>
      ) : !d ? (
        <div className="summary small">
          {draft?.state === 'failed' ? 'AIの下書きを作れませんでした。' : 'AIの下書きはまだありません。'}
          <button className="btn" type="button" onClick={() => void requestDraft(it.id, true)}>
            作る
          </button>
        </div>
      ) : (
        <div className="summary ai">
          <b>AIの要点{d.industry ? `（${d.industry}）` : ''}</b>
          {d.summary && <p className="sumtext">{d.summary}</p>}
          {d.points && d.points.length > 0 && (
            <dl className="points">
              {d.points.map((p, i) => (
                <div key={i}>
                  <dt>{p.label}</dt>
                  <dd>{p.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {d.angles && d.angles.length > 0 && (
            <>
              <b className="subhead">営業トークの切り口</b>
              <ul className="angles">
                {d.angles.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {d.fits && d.fits.length > 0 && (
            <>
              <b className="subhead">相性のよいサービス</b>
              <ul className="fits">
                {d.fits.map((f, i) => (
                  <li key={i}>
                    <span className="pill">{f.service}</span> {f.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button className="linkbtn small" type="button" onClick={() => void requestDraft(it.id, true)}>
            作り直す
          </button>
        </div>
      )}
    </section>
  );
}
