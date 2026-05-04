import numpy as np
from PIL import Image


_GRADS = np.array([
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
], dtype=np.float32)


def _hash(ix, iy, seed):
    h = (ix.astype(np.int64) * 1619 + iy.astype(np.int64) * 31337 + np.int64(seed) * 1337)
    h ^= (h >> 13)
    h *= 1274126177
    h ^= (h >> 16)
    return (h & 7).astype(np.int64)


def perlin2(x, y, seed=0):
    xi = np.floor(x).astype(np.int64)
    yi = np.floor(y).astype(np.int64)
    xf = (x - xi).astype(np.float32)
    yf = (y - yi).astype(np.float32)

    u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
    v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)

    def grad(ix, iy, dx, dy):
        g = _GRADS[_hash(ix, iy, seed)]
        return g[..., 0] * dx + g[..., 1] * dy

    n00 = grad(xi, yi, xf, yf)
    n10 = grad(xi + 1, yi, xf - 1, yf)
    n01 = grad(xi, yi + 1, xf, yf - 1)
    n11 = grad(xi + 1, yi + 1, xf - 1, yf - 1)

    nx0 = n00 + u * (n10 - n00)
    nx1 = n01 + u * (n11 - n01)
    return nx0 + v * (nx1 - nx0)


def fbm(x, y, octaves=5, lacunarity=2.0, gain=0.5, seed=0):
    total = np.zeros_like(x, dtype=np.float32)
    amp, freq, norm = 1.0, 1.0, 0.0
    for i in range(octaves):
        total += amp * perlin2(x * freq, y * freq, seed=seed + i * 131)
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def make_marble(
    width=500,
    height=500,
    seed=7,
    color_stops=None,
):
    if color_stops is None:
        color_stops = [
            [0.00, 0.30, 0.02, 0.00],
            [0.20, 0.55, 0.06, 0.00],
            [0.40, 0.82, 0.18, 0.04],
            [0.62, 0.94, 0.34, 0.10],
            [0.78, 1.00, 0.65, 0.30],
            [0.90, 1.00, 0.93, 0.78],
            [1.00, 1.00, 1.00, 0.98],
        ]

    stops = np.array(color_stops)
    t_stops = stops[:, 0]
    r_stops = stops[:, 1]
    g_stops = stops[:, 2]
    b_stops = stops[:, 3]

    aspect = width / height
    X, Y = np.meshgrid(
        np.linspace(0, 2.0 * aspect, width).astype(np.float32),
        np.linspace(0, 2.0, height).astype(np.float32),
    )

    W = 2.8
    qx = fbm(X, Y, octaves=3, seed=seed + 11)
    qy = fbm(X + 5.2, Y + 1.3, octaves=3, seed=seed + 23)

    rx = fbm(X + W * qx, Y + W * qy + 1.7, octaves=3, seed=seed + 41)
    ry = fbm(X + W * qx + 8.3, Y + W * qy + 2.8, octaves=3, seed=seed + 59)

    Xw = X + W * rx
    Yw = Y + W * ry

    turb = np.abs(fbm(Xw * 0.7, Yw * 0.7, octaves=4, seed=seed + 71))
    streaks = np.sin(0.85 * np.pi * (Xw * 1.0 + 3.5 * turb))

    base = (fbm(Xw, Yw, octaves=4, seed=seed + 89) + 1) * 0.5
    bright = np.clip((streaks + 1) * 0.5, 0, 1) ** 5
    dip = np.clip((1 - streaks) * 0.5, 0, 1) ** 3
    macro = (fbm(X * 0.45, Y * 0.45, octaves=2, seed=seed + 7) + 1) * 0.5

    floor = 0.30 + 0.15 * macro
    body = 0.18 * base
    peaks = 0.55 * bright
    shadow = 0.12 * dip

    t_val = floor + body + peaks - shadow
    t_val = np.clip(t_val, 0, 1)

    r = np.interp(t_val, t_stops, r_stops)
    g = np.interp(t_val, t_stops, g_stops)
    b = np.interp(t_val, t_stops, b_stops)

    rgb = np.stack([r, g, b], axis=-1)
    return Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))