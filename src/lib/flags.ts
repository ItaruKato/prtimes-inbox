/**
 * AIのおすすめ度で振り分けるか。
 * false のあいだは、新作ゲームの案内だけを「不要」に入れ、それ以外はすべて受信箱に入れる。
 * （AIの判定が低くても読みたい記事が埋もれていたため、いったん止めている。戻すときは true にし、
 *   functions/src/index.ts の AI_ENABLED も true にする）
 * 他のモジュールを import しないこと（読み込み時に参照されるため、循環 import を避ける）。
 */
export const AI_SCORING = false;
