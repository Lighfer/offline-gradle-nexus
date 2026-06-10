'use strict';

// 长任务按钮的秒表 + 阶段标签：在按钮文案上即时显示已耗时与当前阶段，
// 让用户在 Gradle 冷启动等长操作中能看到「确实在跑、跑了多久、当前在做什么」。

/**
 * 启动按钮 timer。
 * @param {HTMLButtonElement} btn
 * @param {string} baseLabel 按钮基础文案，例如「分析依赖树」
 * @param {string[]} [stages] 可选阶段顺序，约定每隔 N 秒推进一格；不传则只显示秒表。
 * @returns {{ stop: () => number, setStage: (label: string) => void }}
 */
export function startTimer(btn, baseLabel, stages) {
  if (!btn) return { stop: () => 0, setStage: () => {} };
  const startedAt = Date.now();
  const original = btn.textContent;
  btn.dataset.oldText = original;
  btn.disabled = true;

  let stage = stages && stages.length ? stages[0] : '';

  const render = () => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    if (stages && stages.length > 1) {
      // 每 12 秒推进一档，封顶到最后一格；纯启发式，仅作 UI 提示，不与服务端真实进度强绑定。
      const step = Math.min(stages.length - 1, Math.floor(sec / 12));
      stage = stages[step];
    }
    btn.textContent = stage ? `${baseLabel}（${stage} · ${sec}s）` : `${baseLabel}（${sec}s）`;
  };

  render();
  const timer = setInterval(render, 250);

  return {
    stop() {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = btn.dataset.oldText || baseLabel;
      return Date.now() - startedAt;
    },
    setStage(label) {
      stage = String(label || '');
      render();
    }
  };
}
