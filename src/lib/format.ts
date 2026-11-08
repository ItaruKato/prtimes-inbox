const WD = '日月火水木金土';
const pad = (n: number) => String(n).padStart(2, '0');

export const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
};
export const hm = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fullDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm(ts)}`;
};
export const num = (n: number) => n.toLocaleString('ja-JP');
