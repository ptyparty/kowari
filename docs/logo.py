import math
import sys

DRUMS = {
    "blue": dict(side=("#223b52", "#3b6a8a", "#1a2b3c"), seam="#16232f", lid=("#a9c3ef", "#5a7cb8"), ring="#dcd7ba", gap=0),
    "ochre": dict(side=("#5e2c1a", "#a5573a", "#45200f"), seam="#3a1a0e", lid=("#f2c99a", "#c47a4c"), ring="#fff3dc", gap=0),
    "ink": dict(side=("#1a1a22", "#363646", "#121218"), seam="#0b0b10", lid=("#3a3a4e", "#22222e"), ring="#7e9cd8", gap=0),
    "platters": dict(side=("#24476b", "#3f7cb0", "#1b3550"), seam="#14283d", lid=("#b8d4f5", "#5d93cf"), ring="#ffffff", gap=7),
}
DRUMS["blue-clean"] = dict(DRUMS["blue"], rows="none")
DRUMS["blue-cells"] = dict(DRUMS["blue"], rows="cells")
DRUMS["blue-lock"] = dict(DRUMS["blue"], lock=True)
DRUMS["blue-squat"] = dict(DRUMS["blue"], rx=80, ry=24, tops=[100, 146, 192], h=44)
DRUMS["tall-linedot"] = dict(DRUMS["blue"], rows="linedot", ld=["#98bb6c"] * 3)
DRUMS["tall-linedot-colour"] = dict(DRUMS["blue"], rows="linedot", ld=["#98bb6c", "#e6c384", "#7e9cd8"])
DRUMS["squat-linedot"] = dict(DRUMS["blue-squat"], rows="linedot", ld=["#98bb6c"] * 3)
DRUMS["squat-linedot-colour"] = dict(DRUMS["blue-squat"], rows="linedot", ld=["#98bb6c", "#e6c384", "#7e9cd8"])

TAILS = {
    "guard": dict(
        spine=[[(112, 204), (26, 206), (44, 278), (150, 274)], [(150, 274), (214, 270), (238, 246), (236, 196)], [(236, 196), (240, 130), (258, 70), (232, 22)]],
        behind=0.14, brush=0.52, maxw=27, tufts=[(0.22, 1), (0.55, 1), (0.35, -1), (0.62, -1)],
    ),
    "over": dict(
        spine=[[(112, 204), (26, 206), (44, 278), (150, 274)], [(150, 274), (214, 270), (240, 246), (240, 190)], [(240, 190), (244, 110), (230, 46), (176, 34)], [(176, 34), (150, 30), (124, 34), (104, 46)]],
        behind=0.11, brush=0.46, maxw=24, tufts=[(0.2, 1), (0.42, 1), (0.64, 1), (0.3, -1), (0.55, -1)],
    ),
    "curled": dict(
        spine=[[(196, 196), (262, 194), (264, 258), (196, 264)], [(196, 264), (136, 270), (70, 268), (56, 236)], [(56, 236), (40, 214), (34, 190), (46, 166)]],
        behind=0.12, brush=0.3, maxw=21, tufts=[(0.2, 1), (0.42, 1), (0.64, 1), (0.84, 1), (0.3, -1), (0.6, -1)],
    ),
    "banner": dict(
        spine=[[(196, 210), (230, 214), (250, 190), (250, 150)], [(250, 150), (250, 96), (240, 50), (212, 14)]],
        behind=0.18, brush=0.3, maxw=31, tufts=[(0.18, 1), (0.4, 1), (0.62, 1), (0.28, -1), (0.52, -1), (0.74, -1)],
    ),
}

CX, RX, RY = 140, 68, 21
TOPS = [74, 130, 186]
H = 50


def wrap_tail(gap, cy=236, rise=12, maxw=29):
    k = 0.5523
    a = RX + 7 + gap
    b = RY + 4 + gap * 0.45
    xr = CX + a
    return dict(
        spine=[
            [(CX - RX + 20, cy - 12), (CX - RX - gap * 0.5, cy - 12), (CX - a, cy - 7), (CX - a, cy)],
            [(CX - a, cy), (CX - a, cy + k * b), (CX - k * a, cy + b), (CX, cy + b)],
            [(CX, cy + b), (CX + k * a, cy + b), (xr, cy + k * b), (xr, cy)],
            [(xr, cy), (xr + 8, cy - 70), (xr + rise + 14, cy - 140), (xr + rise - 16, cy - 214)],
        ],
        brush_t=0.02, maxw=maxw, tufts=[(0.22, 1), (0.55, 1), (0.35, -1), (0.62, -1)],
    )


WRAPS = {
    "snug": dict(gap=0, rise=4),
    "close": dict(gap=8, rise=8),
    "loose": dict(gap=24, rise=14),
    "waist": dict(gap=0, cy=206, rise=4),
}


def f2(p):
    return f"{p[0]:.1f} {p[1]:.1f}"


def bez(p, t):
    u = 1 - t
    return tuple(u**3 * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t**3 * p[3][i] for i in range(2))


class Spine:
    def __init__(self, segs):
        self.segs = segs
        lens = []
        for seg in segs:
            pts = [bez(seg, i / 50) for i in range(51)]
            lens.append(sum(math.dist(pts[i], pts[i + 1]) for i in range(50)))
        total = sum(lens)
        self.cuts = []
        acc = 0
        for length in lens:
            self.cuts.append((acc / total, (acc + length) / total))
            acc += length

    def at(self, s):
        for seg, (a, b) in zip(self.segs, self.cuts):
            if s <= b or seg is self.segs[-1]:
                return bez(seg, min(1, max(0, (s - a) / (b - a))))

    def tangent(self, s):
        e = 1e-3
        x0, y0 = self.at(max(0, s - e))
        x1, y1 = self.at(min(1, s + e))
        n = math.hypot(x1 - x0, y1 - y0)
        return (x1 - x0) / n, (y1 - y0) / n

    def offset(self, s, d):
        x, y = self.at(s)
        tx, ty = self.tangent(s)
        return (x - ty * d, y + tx * d)


def smooth(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)


def tube_w(s):
    return 5 + 4 * s


def tube(sp, s0, s1, n=90):
    left = [sp.offset(s0 + (s1 - s0) * i / n, tube_w(s0 + (s1 - s0) * i / n)) for i in range(n + 1)]
    right = [sp.offset(s0 + (s1 - s0) * i / n, -tube_w(s0 + (s1 - s0) * i / n)) for i in range(n + 1)]
    return "M" + " L".join(f2(p) for p in left + right[::-1]) + " Z"


def brush_path(sp, b0, maxw, tufts, n=160):
    def w(u):
        base = tube_w(b0) + (maxw - tube_w(b0)) * smooth(u / 0.45)
        return base * min(1, (1 - u) / 0.42) ** 0.8

    def s_of(u):
        return b0 + (1 - b0) * u

    def edge(side):
        marks = sorted(u for u, sd in tufts if sd == side)
        out = []
        i = 0
        while i <= n:
            u = i / n
            if marks and u >= marks[0]:
                m = marks.pop(0)
                base = sp.offset(s_of(m), side * w(m))
                back_u = m + 0.07
                back = sp.offset(s_of(back_u), side * w(back_u))
                tx, ty = sp.tangent(s_of(m))
                nx, ny = -ty * side, tx * side
                reach = 0.2 * w(m) + 3
                tip = (base[0] + nx * reach + tx * reach * 2.2, base[1] + ny * reach + ty * reach * 2.2)
                c1 = (base[0] + nx * reach * 0.4 + tx * reach * 0.9, base[1] + ny * reach * 0.4 + ty * reach * 0.9)
                c2 = ((tip[0] + back[0]) / 2 - nx * 2, (tip[1] + back[1]) / 2 - ny * 2)
                out.append(("L", base))
                out.append(("Q", c1, tip))
                out.append(("Q", c2, back))
                i = int(back_u * n) + 1
                continue
            out.append(("L", sp.offset(s_of(u), side * w(u))))
            i += 1
        return out

    left = edge(1)
    right = edge(-1)
    parts = ["M" + f2(left[0][1])]
    for op in left[1:]:
        parts.append("L" + f2(op[1]) if op[0] == "L" else "Q" + f2(op[1]) + " " + f2(op[2]))
    rev = []
    pts = [right[0][1]]
    for op in right[1:]:
        pts.append(op[-1])
    for k in range(len(right) - 1, 0, -1):
        op = right[k]
        prev = pts[k - 1]
        rev.append("L" + f2(prev) if op[0] == "L" else "Q" + f2(op[1]) + " " + f2(prev))
    parts.append("L" + f2(pts[-1]))
    parts.extend(rev)
    return " ".join(parts) + " Z"


def drum(d, a):
    gap = d["gap"]
    tops = [t - gap * (2 - i) for i, t in enumerate(TOPS)]
    h = H - gap
    for t in reversed(tops):
        b = t + h
        a(f'<path d="M{CX - RX} {t} V{b} A{RX} {RY} 0 0 0 {CX + RX} {b} V{t} Z" fill="url(#drum)"/>')
        a(f'<path d="M{CX - RX + 3} {b} A{RX - 3} {RY - 1} 0 0 0 {CX + RX - 3} {b}" fill="none" stroke="{d["ring"]}" stroke-width="2" opacity="0.2"/>')
        a(f'<ellipse cx="{CX}" cy="{t}" rx="{RX}" ry="{RY}" fill="{d["seam"] if not gap else "url(#lid)"}"/>')
    rows = d.get("rows", "bars")
    if rows == "linedot":
        for t, col in zip(tops, d["ld"]):
            y = t + RY + h / 2 - 2
            pts = []
            for i in range(21):
                x = CX - RX + 16 + 34 * i / 20
                pts.append((x, y + RY * math.sqrt(max(0, 1 - ((x - CX) / RX) ** 2)) - RY))
            a('<path d="M' + " L".join(f2(p) for p in pts) + '" fill="none" stroke="#dcd7ba" stroke-width="5" stroke-linecap="round" opacity="0.55"/>')
            dx = CX - RX + 62
            dy = y + RY * math.sqrt(max(0, 1 - ((dx - CX) / RX) ** 2)) - RY
            a(f'<circle cx="{dx:.1f}" cy="{dy:.1f}" r="4.5" fill="{col}"/>')
            a(f'<circle cx="{dx:.1f}" cy="{dy:.1f}" r="8" fill="{col}" opacity="0.18"/>')
    for t in tops[1:]:
        if rows == "bars":
            for k, (wd, col) in enumerate([(30, "#98bb6c"), (20, "#e6c384"), (25, "#7e9cd8")]):
                a(f'<rect x="{CX + 2}" y="{t + 17 + k * 9}" width="{wd}" height="5.5" rx="2.75" fill="{col}" opacity="0.8"/>')
        elif rows == "cells":
            for r in range(2):
                x = CX - 40
                for wd, col in [(20, "#98bb6c"), (14, "#e6c384"), (22, "#7e9cd8"), (12, "#957fb8")]:
                    mid = x + wd / 2 - CX
                    sag = RY * math.sqrt(max(0, 1 - (mid / RX) ** 2)) - RY
                    a(f'<rect x="{x:.1f}" y="{t + RY + 6 + r * 11 + sag:.1f}" width="{wd}" height="6" rx="3" fill="{col}" opacity="{0.8 - 0.25 * r:.2f}"/>')
                    x += wd + 4
    if d.get("lock"):
        lx, ly = CX + 22, tops[0] + RY + 14
        a(f'<path d="M{lx - 6} {ly} V{ly - 5} A6 6 0 0 1 {lx + 6} {ly - 5} V{ly}" fill="none" stroke="#dcd7ba" stroke-width="3" opacity="0.75"/>')
        a(f'<rect x="{lx - 10}" y="{ly}" width="20" height="15" rx="3.5" fill="#e6c384" opacity="0.9"/>')
        a(f'<circle cx="{lx}" cy="{ly + 6.5}" r="2.3" fill="#2a2a37"/><rect x="{lx - 1}" y="{ly + 7}" width="2" height="5" rx="1" fill="#2a2a37"/>')
    t0 = tops[0]
    a(f'<ellipse cx="{CX}" cy="{t0}" rx="{RX}" ry="{RY}" fill="url(#lid)"/>')
    a(f'<ellipse cx="{CX}" cy="{t0}" rx="{RX - 13}" ry="{RY - 6}" fill="none" stroke="{d["ring"]}" stroke-width="2.5" opacity="0.4"/>')
    a(f'<ellipse cx="{CX - 24}" cy="{t0 - 8}" rx="15" ry="3.5" fill="#fff" opacity="0.4" transform="rotate(-7 {CX - 24} {t0 - 8})"/>')


def logo(drum_name, tail_name):
    global RX, RY, TOPS, H
    d = DRUMS[drum_name]
    RX, RY, TOPS, H = d.get("rx", 68), d.get("ry", 21), d.get("tops", [74, 130, 186]), d.get("h", 50)
    t = TAILS[tail_name] if tail_name in TAILS else wrap_tail(**WRAPS[tail_name])
    sp = Spine(t["spine"])
    if "brush_t" in t:
        c0, c1 = sp.cuts[3]
        t = dict(t, behind=sp.cuts[0][1], brush=c0 + t["brush_t"] * (c1 - c0))
    b0 = t["brush"]
    p0, p1 = sp.at(b0 - 0.1), sp.at(1)
    out = []
    a = out.append
    a('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><defs>')
    s0, s1, s2 = d["side"]
    a(f'<linearGradient id="drum" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{s0}"/><stop offset="0.38" stop-color="{s1}"/><stop offset="1" stop-color="{s2}"/></linearGradient>')
    a(f'<linearGradient id="lid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{d["lid"][0]}"/><stop offset="1" stop-color="{d["lid"][1]}"/></linearGradient>')
    q0, q1 = sp.at(0), sp.at(b0)
    a(f'<linearGradient id="fur" gradientUnits="userSpaceOnUse" x1="{q0[0]:.0f}" y1="{q0[1]:.0f}" x2="{q1[0]:.0f}" y2="{q1[1]:.0f}"><stop offset="0" stop-color="#f3cf92"/><stop offset="0.6" stop-color="#d48a4e"/><stop offset="1" stop-color="#9a4a2e"/></linearGradient>')
    a(f'<linearGradient id="brush" gradientUnits="userSpaceOnUse" x1="{p0[0]:.0f}" y1="{p0[1]:.0f}" x2="{p1[0]:.0f}" y2="{p1[1]:.0f}"><stop offset="0" stop-color="#9a4a2e"/><stop offset="0.16" stop-color="#3a2420"/><stop offset="0.36" stop-color="#2a2a37"/><stop offset="1" stop-color="#0e0e14"/></linearGradient>')
    a('<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a9ab0" stop-opacity="0"/><stop offset="0.5" stop-color="#9a9ab0" stop-opacity="0.55"/><stop offset="1" stop-color="#9a9ab0" stop-opacity="0"/></linearGradient>')
    a("</defs>")
    a('<ellipse cx="150" cy="270" rx="112" ry="12" fill="#000" opacity="0.16"/>')
    behind = t["behind"]
    a(f'<path d="{tube(sp, 0, behind + 0.02)}" fill="url(#fur)"/>')
    drum(d, a)
    a(f'<path d="{tube(sp, behind + 0.06, b0 + 0.05)}" fill="#000" opacity="0.22" transform="translate(2 4)"/>')
    a(f'<path d="{tube(sp, behind, b0 + 0.05)}" fill="url(#fur)"/>')
    hl = [sp.offset(behind + 0.04 + (b0 - behind - 0.08) * i / 30, -3.5) for i in range(31)]
    a('<path d="M' + " L".join(f2(p) for p in hl) + '" fill="none" stroke="#fff3dc" stroke-width="2" stroke-linecap="round" opacity="0.5"/>')
    br = brush_path(sp, b0, t["maxw"], t["tufts"])
    a(f'<path d="{br}" fill="#000" opacity="0.22" transform="translate(3 4)"/>')
    a(f'<path d="{br}" fill="url(#brush)" stroke="#727169" stroke-width="1.5" stroke-opacity="0.5" stroke-linejoin="round"/>')
    inner = brush_path(sp, b0 + (1 - b0) * 0.12, t["maxw"] * 0.45, [])
    a(f'<path d="{inner}" fill="#54546d" opacity="0.28" transform="translate(-2 -1)"/>')
    a("</svg>")
    return "".join(out)


if __name__ == "__main__":
    print(logo(sys.argv[1] if len(sys.argv) > 1 else "blue", sys.argv[2] if len(sys.argv) > 2 else "guard"))
