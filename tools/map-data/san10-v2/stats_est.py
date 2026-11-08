# 모드 능력치가 있는 인물의 열전으로 능선 회귀를 학습해, 능력치가 없는 인물을 같은 눈금으로 산정한다.
import json, sys, io
import numpy as np
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
S = sys.argv[1]  # resources/map-drafts/san10-v2
d = json.load(open(S + '/data/data2.json', encoding='utf-8'))
ro = d['roster']
known = [r for r in ro if r[9] == '모드' and r[7]]
target = [r for r in ro if r[9] != '모드']
print('known', len(known), 'target', len(target))


def grams(t):
    t = ''.join(t.split())
    return set(t[i:i + 2] for i in range(len(t) - 1))


df = {}
for r in ro:
    for g in grams(r[7] or ''):
        df[g] = df.get(g, 0) + 1
vocab = [g for g, c in sorted(df.items(), key=lambda x: -x[1]) if 8 <= c <= len(ro) * 0.5][:1800]
idx = {g: i for i, g in enumerate(vocab)}
print('vocab', len(vocab))


def vec(r):
    v = np.zeros(len(vocab) + 1)
    for g in grams(r[7] or ''):
        i = idx.get(g)
        if i is not None:
            v[i] = 1
    v[-1] = min(len(r[7] or ''), 400) / 400
    return v


X = np.array([vec(r) for r in known])
Y = np.array([r[8] for r in known], dtype=float)
mean_x, mean_y = X.mean(0), Y.mean(0)


def fit(Xa, Ya, a):
    mx, my = Xa.mean(0), Ya.mean(0)
    A = Xa - mx
    # 표본이 특징보다 적으므로 쌍대형으로 푼다
    K = A @ A.T + a * np.eye(len(A))
    w = A.T @ np.linalg.solve(K, Ya - my)
    return w, mx, my


rng = np.random.default_rng(10)
order = rng.permutation(len(X))
folds = np.array_split(order, 5)
best = None
for a in [3, 10, 30, 100, 300]:
    errs = []
    for f in folds:
        tr = np.setdiff1d(order, f)
        w, mx, my = fit(X[tr], Y[tr], a)
        errs.append(np.abs((X[f] - mx) @ w + my - Y[f]))
    e = np.concatenate(errs).mean(0)
    print('alpha', a, 'MAE', np.round(e, 1).tolist())
    if best is None or e.mean() < best[1].mean():
        best = (a, e)
base = np.abs(Y - mean_y).mean(0)
print('best', best[0], 'MAE', np.round(best[1], 1).tolist(), 'baseline(평균)', np.round(base, 1).tolist())
w, mx, my = fit(X, Y, best[0])
Xt = np.array([vec(r) for r in target])
P = (Xt - mx) @ w + my
# 모드 인물보다 비중이 작은 사람들이므로 모드 상위 10% 값을 넘기지 않는다
hi = np.percentile(Y, 90, axis=0)
lo = np.percentile(Y, 5, axis=0)
P = np.clip(P, lo, hi)
out = {str(r[0]): [int(round(x)) for x in p] for r, p in zip(target, P)}
json.dump(out, open(S + '/data/stats-est.json', 'w', encoding='utf-8'))
json.dump({'known': len(known), 'target': len(target), 'mae': np.round(best[1], 1).tolist(), 'base': np.round(base, 1).tolist(), 'hi': hi.tolist(), 'lo': lo.tolist(), 'meanKnown': np.round(mean_y, 1).tolist(), 'meanEst': np.round(P.mean(0), 1).tolist()}, open(S + '/data/stats-meta.json', 'w', encoding='utf-8'))
print('mean known', np.round(mean_y, 1).tolist(), 'mean est', np.round(P.mean(0), 1).tolist(), 'clip', hi.tolist(), lo.tolist())
for r in target[:6]:
    print(r[1], out[str(r[0])], (r[7] or '')[:40])
