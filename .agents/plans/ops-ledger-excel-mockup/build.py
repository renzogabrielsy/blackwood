import json, datetime as dt
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.comments import Comment

CAMPS = [("JULY 2026", "july", "JULY-2026"), ("AUGUST 2026", "august", "AUGUST-2026"), ("SEPTEMBER 2026", "september", "SEPTEMBER-2026")]
DATA = {name: json.load(open(f"{f}.json")) for name, f, _ in CAMPS}
KPIS = {k["key"]: k for k in json.load(open("kpis.json"))}
GRADES = ["3X50", "6X50", "8X50", "2X6", "4X8"]
STREAMS = ["TRML 1", "TRML 2", "RS1A", "RS1B", "RS2/3", "RS5", "BF", "GRITS"]

F = "Arial"
f_base = Font(name=F, size=10)
# FORMAT v2 (Renzo's edited mock-up, 2026-09-17): ALL TEXT BLACK on the month tabs and the RC Movement
# day rows — no blue-input / green-link / grey-muted colour coding. Only the Checks tab keeps colours.
f_in = Font(name=F, size=10)
f_link = Font(name=F, size=10)
f_link_rc = Font(name=F, size=10, color="008000")     # RC Movement block footers + Checks keep the green link colour
f_bold = Font(name=F, size=10, bold=True)
f_title = Font(name=F, size=14, bold=True)
f_sub = Font(name=F, size=9)
f_sub_rc = Font(name=F, size=9, color="666666")      # RC Movement keeps its grey subtitle + block-location labels
f_hdr = Font(name=F, size=9, bold=True)
f_mut = Font(name=F, size=9)
thin = Side(style="thin", color="BFBFBF"); med = Side(style="medium", color="7F7F7F")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
TOP = Border(left=thin, right=thin, top=med, bottom=thin)
FILL = {k: PatternFill("solid", fgColor=v) for k, v in dict(
    day="EDEDED", price="E4DFEC", fed="DDEBF7", prod="E2EFDA", waste="FCE4E4", loss="FFF2CC",
    shift="EDEDED", total="F2F2F2", rest="F7F7F7", ok="E2EFDA", bad="F8CBAD").items()}
KG = '#,##0;-#,##0;;@'; KG1 = '#,##0.0;-#,##0.0;;@'; T1 = '#,##0.0'; PCT = '0.00%;-0.00%;;@'
PHP = '"₱"#,##0.00;-"₱"#,##0.00;;@'; HRS = '0.00;-0.00;;@'; DATE = 'mm-dd-yy'          # v2: Renzo's date format
R = Alignment(horizontal="right", vertical="center"); C = Alignment(horizontal="center", vertical="center", wrap_text=True)
LFT = Alignment(horizontal="left", vertical="center")

def q(sheet): return f"'{sheet}'"
def put(ws, ref, v, font=f_base, fmt=None, fill=None, al=None, border=BOX):
    c = ws[ref]; c.value = v; c.font = font
    if fmt: c.number_format = fmt
    if fill: c.fill = fill
    if al: c.alignment = al
    if border: c.border = border
    return c
def d(s): return dt.date.fromisoformat(s) if s else None

wb = Workbook()
ws_eoq = wb.active; ws_eoq.title = "EOQ Summary"
ws_m = {name: wb.create_sheet(name) for name, _, _ in CAMPS}
ws_rc = wb.create_sheet("RC Movement")
ws_ck = wb.create_sheet("Checks")

# ───────────────────────── RC MOVEMENT (three tables, one tab) ─────────────────────────
rc = {}  # name -> dict(row_of_date, col_of_batch, total_row, first_day, last_day)
ws = ws_rc
put(ws, "A1", "RC MOVEMENT — Q3 2026", f_title, border=None)
# v3: no subtitle line
_ = ("One table per campaign, stacked. Blue = database value · black = formula · green = link to another tab. kg fed by block per day; the footer is this campaign's kg, the block's delivered ₱/kg, its resiko loss and its actual ₱/kg.")
r = 3
for name, _, _ in CAMPS:
    D = DATA[name]; blocks = D["blocks"]; days = D["days"]
    put(ws, f"A{r}", f"{name} · {days[0][0]} → {days[-1][0]} · {len(days)} days · {len(blocks)} blocks", f_bold, border=None)
    h1, h2 = r + 1, r + 2
    for i, (lab, fill) in enumerate([("#", "day"), ("DATE", "day"), ("DAY", "day"), ("FED ₱/kg", "price"), ("TOTAL FED kg", "fed")]):
        ws.merge_cells(start_row=h1, start_column=i + 1, end_row=h2, end_column=i + 1)
        put(ws, f"{L(i+1)}{h1}", lab, f_hdr, fill=FILL[fill], al=C); ws[f"{L(i+1)}{h2}"].border = BOX
    col_of = {}
    for j, b in enumerate(blocks):
        col = L(6 + j); col_of[b[0]] = col
        put(ws, f"{col}{h1}", b[0], f_hdr, fill=FILL["fed"], al=C)
        put(ws, f"{col}{h2}", b[1] or "—", f_sub_rc, fill=FILL["fed"], al=C)
    lastc = L(5 + len(blocks))
    cells = {(c[0], c[1]): c[2] for c in D["cells"]}
    row_of = {}
    for n, day in enumerate(days):
        rr = h2 + 1 + n; row_of[day[0]] = rr
        rest = day[3] is None and day[14] is None and day[4] == 0
        fill = FILL["rest"] if rest else None
        put(ws, f"A{rr}", n + 1, f_mut, fill=fill, al=R); put(ws, f"B{rr}", d(day[0]), f_base, DATE, fill, LFT)
        put(ws, f"C{rr}", day[1], f_base, None, fill, LFT); put(ws, f"D{rr}", day[2], f_in, PHP, fill, R)
        put(ws, f"E{rr}", f"=SUM(F{rr}:{lastc}{rr})", f_bold, KG, fill, R)
        for b in blocks:
            put(ws, f"{col_of[b[0]]}{rr}", cells.get((day[0], b[0])), f_in, KG, fill, R)
    first, last = h2 + 1, h2 + len(days); tot = last + 1
    put(ws, f"A{tot}", None, fill=FILL["total"], border=TOP); put(ws, f"B{tot}", "FED kg (this campaign)", f_bold, fill=FILL["total"], border=TOP)
    put(ws, f"C{tot}", None, fill=FILL["total"], border=TOP)
    put(ws, f"D{tot}", f'=SUMPRODUCT(D{first}:D{last},E{first}:E{last})/SUMIF(D{first}:D{last},">0",E{first}:E{last})', f_bold, PHP, FILL["total"], R, TOP)
    put(ws, f"E{tot}", f"=SUM(E{first}:E{last})", f_bold, KG, FILL["total"], R, TOP)
    for b in blocks:
        col = col_of[b[0]]; put(ws, f"{col}{tot}", f"=SUM({col}{first}:{col}{last})", f_bold, KG, FILL["total"], R, TOP)
    rc[name] = dict(row_of=row_of, col_of=col_of, tot=tot, first=first, last=last, lastc=lastc)
    r = tot + 6   # three footer rows are written after the month tabs exist (they link to them)
ws.freeze_panes = "F3"
ws.column_dimensions["A"].width = 4; ws.column_dimensions["B"].width = 22; ws.column_dimensions["C"].width = 6
ws.column_dimensions["D"].width = 11; ws.column_dimensions["E"].width = 13
for j in range(6, 6 + max(len(DATA[n]["blocks"]) for n, _, _ in CAMPS)): ws.column_dimensions[L(j)].width = 15

# ───────────────────────── MONTH TABS ─────────────────────────
M = {}  # name -> addresses the summary / checks need
for name, _, key in CAMPS:
    ws = ws_m[name]; D = DATA[name]; days = D["days"]; blocks = D["blocks"]; R_ = rc[name]
    rest_n = sum(1 for x in days if x[3] is None and x[14] is None and x[4] == 0)
    put(ws, "A1", f"{name} — PLANT OPERATIONS", f_title, border=None)
    # v3: no subtitle line
    # EOM rollup (row 4 labels, row 5 formulas)
    kp = [("RC FED (t)", "fed", T1), ("PRODUCED (t)", "prod", T1), ("YIELD", "prod", PCT), ("LOSS", "loss", PCT), ("WASTE (kg)", "waste", KG1),
          ("WASTE %", "waste", PCT), ("FED PRICE (₱/kg)", "price", PHP), ("ACTUAL FED PRICE (₱/kg)", "price", PHP), ("RESIKO COST (₱/kg)", "price", PHP),
          ("RESIKO LOSS", "loss", PCT), ("PC COST (₱/kg)", "price", PHP), ("TRUE PC COST (₱/kg)", "price", PHP), ("fed kg in price set", "day", KG)]
    put(ws, "A3", "EOM ROLLUP", f_hdr, fill=FILL["day"], al=LFT); put(ws, "A4", name, f_bold, al=LFT)
    for i, (lab, fill, _) in enumerate(kp): put(ws, f"{L(2+i)}3", lab, f_hdr if i < 12 else f_mut, fill=FILL[fill], al=C)
    # ledger
    g1, g2 = 7, 8
    cols = [("DATE", "day"), ("DAY", "day"), ("FED PRICE ₱/kg", "price"), ("TTL FED kg", "fed"), ("TTL PROD kg", "prod"), ("WASTE kg", "waste"), ("WASTE %", "waste"), ("SHIFTS", "shift"), ("DT HRS", "shift")]
    cols += [(f"{g} kg", "prod") for g in GRADES] + [(f"{s} kg", "waste") for s in STREAMS]
    bands = [("DAY", 1, 2, "day"), ("PRICE", 3, 3, "price"), ("FED", 4, 4, "fed"), ("PRODUCED", 5, 5, "prod"), ("WASTE", 6, 7, "waste"), ("SHIFT", 8, 9, "shift"), ("GRADES", 10, 14, "prod"), ("WASTE STREAMS", 15, 22, "waste")]
    for lab, a, b, fill in bands:
        ws.merge_cells(start_row=g1, start_column=a, end_row=g1, end_column=b)
        put(ws, f"{L(a)}{g1}", lab, f_hdr, fill=FILL[fill], al=C)   # v2: group band centred
        for k in range(a, b + 1): ws[f"{L(k)}{g1}"].border = BOX; ws[f"{L(k)}{g1}"].fill = FILL[fill]
    for i, (lab, fill) in enumerate(cols): put(ws, f"{L(1+i)}{g2}", lab, f_hdr, fill=FILL[fill], al=C)
    first = g2 + 1
    for n, day in enumerate(days):
        rr = first + n; grades = day[14] or {}
        rest = day[3] is None and day[14] is None and day[4] == 0
        fill = FILL["rest"] if rest else None
        put(ws, f"A{rr}", d(day[0]), f_base, DATE, fill, LFT); put(ws, f"B{rr}", day[1], f_base, None, fill, LFT)
        put(ws, f"C{rr}", day[2], f_in, PHP, fill, R)
        put(ws, f"D{rr}", f"={q('RC Movement')}!E{R_['row_of'][day[0]]}", f_link, KG, fill, R)
        put(ws, f"E{rr}", f"=SUM(J{rr}:N{rr})", f_base, KG, fill, R)
        put(ws, f"F{rr}", f"=SUM(O{rr}:V{rr})", f_base, KG1, fill, R)
        put(ws, f"G{rr}", f'=IF(E{rr}>0,F{rr}/E{rr},"")', f_base, PCT, fill, R)
        put(ws, f"H{rr}", day[4] or None, f_in, KG, fill, R); put(ws, f"I{rr}", day[5], f_in, HRS, fill, R)
        for i, g in enumerate(GRADES): put(ws, f"{L(10+i)}{rr}", grades.get(g), f_in, KG, fill, R)
        for i in range(8): put(ws, f"{L(15+i)}{rr}", day[6 + i], f_in, KG1, fill, R)
    last = first + len(days) - 1; tot = last + 1
    put(ws, f"A{tot}", name, f_bold, fill=FILL["total"], al=LFT, border=TOP); put(ws, f"B{tot}", f"{len(days)} d", f_mut, fill=FILL["total"], border=TOP)
    put(ws, f"C{tot}", f'=SUMPRODUCT(C{first}:C{last},D{first}:D{last})/SUMIF(C{first}:C{last},">0",D{first}:D{last})', f_bold, PHP, FILL["total"], R, TOP)
    for col, fmt in [("D", KG), ("E", KG), ("F", KG1), ("H", KG), ("I", HRS)] + [(L(10+i), KG) for i in range(5)] + [(L(15+i), KG1) for i in range(8)]:
        put(ws, f"{col}{tot}", f"=SUM({col}{first}:{col}{last})", f_bold, fmt, FILL["total"], R, TOP)
    put(ws, f"G{tot}", f'=IF(E{tot}>0,F{tot}/E{tot},"")', f_bold, PCT, FILL["total"], R, TOP)
    # blocks used
    bt = tot + 3
    put(ws, f"A{bt}", "BLOCKS USED", f_bold, border=None)
    put(ws, f"D{bt}", "FED WT is this campaign's kg (linked to the RC Movement tab), not the block's lifetime. RESIKO is only a loss once the block is CLOSED.", f_sub, border=None)
    bh = bt + 1
    bcols = [("BATCH", "day"), ("BLOCK LOC", "day"), ("DATE OPEN", "day"), ("DATE CLOSE", "day"), ("STATE", "day"), ("FED WT kg", "fed"), ("ARRV WT kg", "fed"),
             ("RESIKO kg", "loss"), ("RESIKO LOSS %", "loss"), ("BLOCK PRICE ₱/kg", "price"), ("ACTUAL PRICE ₱/kg", "price"), ("RESIKO PRICE ₱/kg", "price"), ("IN PRICE SET", "day")]
    for i, (lab, fill) in enumerate(bcols): put(ws, f"{L(1+i)}{bh}", lab, f_hdr, fill=FILL[fill], al=C)
    b1 = bh + 1
    for n, b in enumerate(blocks):
        rr = b1 + n; closed = b[5]
        fill = None if b[12] else FILL["rest"]
        put(ws, f"A{rr}", b[0], f_base, None, fill, LFT); put(ws, f"B{rr}", b[1] or "—", f_base, None, fill, LFT)
        put(ws, f"C{rr}", d(b[2]), f_in, DATE, fill, LFT); put(ws, f"D{rr}", d(b[3]), f_in, DATE, fill, LFT)
        put(ws, f"E{rr}", "CLOSED" if closed else "OPEN", f_in, None, fill, LFT)
        put(ws, f"F{rr}", f"={q('RC Movement')}!{R_['col_of'][b[0]]}{R_['tot']}", f_link, KG, fill, R)
        put(ws, f"G{rr}", b[7], f_in, KG, fill, R); put(ws, f"H{rr}", b[8] if closed else None, f_in, KG, fill, R)
        put(ws, f"I{rr}", f'=IF(AND(E{rr}="CLOSED",G{rr}>0),H{rr}/G{rr},"")', f_base, PCT, fill, R)
        put(ws, f"J{rr}", b[10], f_in, PHP, fill, R); put(ws, f"K{rr}", b[11], f_in, PHP, fill, R)
        put(ws, f"L{rr}", f'=IF(K{rr}="","",K{rr}-J{rr})', f_base, PHP, fill, R)
        put(ws, f"M{rr}", "Y" if b[12] else "N", f_in, None, fill, C)
        if not closed: ws[f"H{rr}"].comment = Comment(f"Still open — {b[9]:,.0f} kg remains in the pile. Not a loss yet.", "Blackwood")
    b2 = b1 + len(blocks) - 1; btot = b2 + 1
    inset = f'(M{b1}:M{b2}="Y")'
    put(ws, f"A{btot}", f"{len(blocks)} blocks", f_bold, fill=FILL["total"], al=LFT, border=TOP)
    put(ws, f"B{btot}", f'=COUNTIF(E{b1}:E{b2},"CLOSED")&" closed · "&COUNTIF(E{b1}:E{b2},"OPEN")&" open · "&COUNTIF(M{b1}:M{b2},"Y")&" in price set"', f_mut, fill=FILL["total"], al=LFT, border=TOP)
    ws.merge_cells(start_row=btot, start_column=2, end_row=btot, end_column=5)
    for k in "CDE": ws[f"{k}{btot}"].border = TOP; ws[f"{k}{btot}"].fill = FILL["total"]
    put(ws, f"F{btot}", f"=SUM(F{b1}:F{b2})", f_bold, KG, FILL["total"], R, TOP)
    put(ws, f"G{btot}", f"=SUM(G{b1}:G{b2})", f_bold, KG, FILL["total"], R, TOP)
    put(ws, f"H{btot}", f"=SUM(H{b1}:H{b2})", f_bold, KG, FILL["total"], R, TOP)
    put(ws, f"I{btot}", f'=SUMIF(E{b1}:E{b2},"CLOSED",H{b1}:H{b2})/SUMIF(E{b1}:E{b2},"CLOSED",G{b1}:G{b2})', f_bold, PCT, FILL["total"], R, TOP)
    put(ws, f"J{btot}", f"=SUMPRODUCT({inset}*F{b1}:F{b2}*J{b1}:J{b2})/SUMPRODUCT({inset}*F{b1}:F{b2})", f_bold, PHP, FILL["total"], R, TOP)
    put(ws, f"K{btot}", f"=SUMPRODUCT({inset}*F{b1}:F{b2}*K{b1}:K{b2})/SUMPRODUCT({inset}*F{b1}:F{b2})", f_bold, PHP, FILL["total"], R, TOP)
    val = f"SUMPRODUCT({inset}*J{b1}:J{b2}*G{b1}:G{b2})"
    put(ws, f"L{btot}", f"={val}/SUMPRODUCT({inset}*(G{b1}:G{b2}-H{b1}:H{b2}))-{val}/SUMPRODUCT({inset}*G{b1}:G{b2})", f_bold, PHP, FILL["total"], R, TOP)
    ws[f"L{btot}"].comment = Comment("RESIKO COST on the WHOLE-BLOCK basis, as the app publishes it: pesos paid / lifetime fed kg, minus pesos paid / arrival kg, over the price set. Note the ACTUAL price beside it is campaign-attributed, so FED PRICE + RESIKO COST is close to, but not exactly, ACTUAL.", "Blackwood")
    put(ws, f"M{btot}", None, fill=FILL["total"], border=TOP)
    ws[f"J{btot}"].comment = Comment("Block price weighted by this campaign's fed kg, over the blocks inside the price set (closed and fully priced).", "Blackwood")
    # EOM rollup formulas
    eom = {"B": (f"=D{tot}/1000", T1), "C": (f"=E{tot}/1000", T1), "D": (f"=E{tot}/D{tot}", PCT), "E": ("=1-D4", PCT), "F": (f"=F{tot}", KG1),
           "G": (f"=F{tot}/E{tot}", PCT), "H": (f"=C{tot}", PHP), "I": (f"=K{btot}", PHP), "J": (f"=L{btot}", PHP), "K": (f"=I{btot}", PCT),
           "L": ("=H4/D4", PHP), "M": (f'=IF(COUNTIF(M{b1}:M{b2},"N")=0,I4/D4,"")', PHP), "N": (f"=SUMPRODUCT({inset}*F{b1}:F{b2})", KG)}
    for col, (fm, fmt) in eom.items(): put(ws, f"{col}4", fm, f_bold if col != "N" else f_mut, fmt, None, R)
    ws["M4"].comment = Comment("Blank on purpose until every block this campaign fed is CLOSED and fully priced.", "Blackwood")
    ws.freeze_panes = f"C{first}"
    widths = [18.16, 14, 12, 12, 12, 12, 10, 12, 12, 12, 14, 14, 13] + [10] * 9
    for i, w in enumerate(widths): ws.column_dimensions[L(1 + i)].width = w
    ws.row_dimensions[3].height = 30; ws.row_dimensions[g2].height = 28; ws.row_dimensions[bh].height = 28
    ws.page_setup.orientation = "landscape"; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0; ws.sheet_properties.pageSetUpPr.fitToPage = True
    M[name] = dict(tot=tot, btot=btot, b1=b1, b2=b2, key=key)

# ─── RC Movement block footers (links into the month tabs' BLOCKS USED tables) ───
ws = ws_rc
for name, _, _ in CAMPS:
    R_ = rc[name]; mm = M[name]; tot = R_["tot"]
    for k, (lab, col, fmt) in enumerate([("₱/KG (block price)", "J", PHP), ("LOSS % (resiko)", "I", PCT), ("ACTUAL ₱/kg", "K", PHP)]):
        rr = tot + 1 + k
        for c in "ACDE": put(ws, f"{c}{rr}", None, fill=FILL["total"])
        put(ws, f"B{rr}", lab, f_hdr, fill=FILL["total"])
        for n, b in enumerate(DATA[name]["blocks"]):
            src = f"{q(name)}!{col}{mm['b1'] + n}"
            put(ws, f"{R_['col_of'][b[0]]}{rr}", f'=IF({src}="","",{src})', f_link_rc, fmt, FILL["total"], R)
ws.page_setup.orientation = "landscape"; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0; ws.sheet_properties.pageSetUpPr.fitToPage = True

# ───────────────────────── EOQ SUMMARY ─────────────────────────
ws = ws_eoq
put(ws, "A1", "EOQ SUMMARY — Q3 2026", f_title, border=None)
# v3: no subtitle line
hdr = [("CAMPAIGN", "day"), ("RC FED (t)", "fed"), ("PRODUCED (t)", "prod"), ("YIELD", "prod"), ("LOSS", "loss"), ("WASTE (kg)", "waste"), ("WASTE %", "waste"),
       ("FED PRICE (₱/kg)", "price"), ("ACTUAL FED PRICE (₱/kg)", "price"), ("RESIKO COST (₱/kg)", "price"), ("RESIKO LOSS", "loss"), ("PC COST (₱/kg)", "price"), ("TRUE PC COST (₱/kg)", "price"), ("fed kg in price set", "day")]
for i, (lab, fill) in enumerate(hdr): put(ws, f"{L(1+i)}3", lab, f_hdr if i < 13 else f_mut, fill=FILL[fill], al=C)
fmts = [None, T1, T1, PCT, PCT, KG1, PCT, PHP, PHP, PHP, PCT, PHP, PHP, KG]
for n, (name, _, _) in enumerate(CAMPS):
    rr = 4 + n; put(ws, f"A{rr}", name, f_bold, al=LFT)
    for i in range(1, 14):
        col = L(1 + i); src = f"{q(name)}!{col}4"
        fm = f'=IF({src}="","",{src})' if col == "M" else f"={src}"
        put(ws, f"{col}{rr}", fm, f_link if col != "N" else f_mut, fmts[i], None, R)
g = 7
put(ws, f"A{g}", "GROUP · Q3 2026", f_bold, fill=FILL["total"], al=LFT, border=TOP)
grp = {"B": "=SUM(B4:B6)", "C": "=SUM(C4:C6)", "D": "=C7/B7", "E": "=1-D7", "F": "=SUM(F4:F6)", "G": "=F7/(C7*1000)",
       "H": "=SUMPRODUCT(H4:H6,B4:B6)/SUM(B4:B6)", "I": "=SUMPRODUCT(I4:I6,N4:N6)/SUM(N4:N6)", "J": "=SUMPRODUCT(J4:J6,N4:N6)/SUM(N4:N6)",
       "K": "=SUMPRODUCT(K4:K6,N4:N6)/SUM(N4:N6)", "L": "=H7/D7", "M": '=IF(COUNTBLANK(M4:M6)=0,I7/D7,"")', "N": "=SUM(N4:N6)"}
for i, col in enumerate("BCDEFGHIJKLMN"): put(ws, f"{col}{g}", grp[col], f_bold if col != "N" else f_mut, fmts[1 + i], FILL["total"], R, TOP)
ws["M7"].comment = Comment("Blank until EVERY campaign in the group is fully covered (all blocks closed and priced).", "Blackwood")
ws["K7"].comment = Comment("The group shows the resiko RATIO only. A resiko kg total is deliberately not shown: a block fed by two campaigns would be counted twice.", "Blackwood")
put(ws, "A9", "CHECKS", f_hdr, fill=FILL["day"], al=LFT)
put(ws, "B9", '=IF(COUNTIF(Checks!F:F,"CHECK")=0,"All "&COUNTIF(Checks!F:F,"OK*")&" checks agree with the database",COUNTIF(Checks!F:F,"CHECK")&" of "&(COUNTIF(Checks!F:F,"OK*")+COUNTIF(Checks!F:F,"CHECK"))&" checks differ — see the Checks tab")', f_bold, al=LFT)
ws.merge_cells("B9:H9")
# v3: the "HOW TO READ THIS FILE" notes block is gone — Renzo removed every explanatory prose line.
ws.freeze_panes = "B4"; ws.row_dimensions[3].height = 32
for i, w in enumerate([22, 12, 13, 10, 10, 13, 10, 13, 15, 14, 12, 13, 14, 13]): ws.column_dimensions[L(1 + i)].width = w
ws.page_setup.orientation = "landscape"; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0; ws.sheet_properties.pageSetUpPr.fitToPage = True

# ───────────────────────── CHECKS ─────────────────────────
ws = ws_ck
put(ws, "A1", "CHECKS — the workbook's formulas against the database's own figures", f_title, border=None)
put(ws, "A2", "WORKBOOK is a live link to the formula cell. DATABASE is the figure the Blackwood views published on 2026-09-17. A row reads CHECK when they differ by more than the tolerance.", f_sub, border=None)
for i, lab in enumerate(["CAMPAIGN", "FIGURE", "WORKBOOK", "DATABASE", "DIFFERENCE", "STATUS", "TOLERANCE"]): put(ws, f"{L(1+i)}4", lab, f_hdr, fill=FILL["day"], al=C)
spec = [("RC fed kg", lambda m: f"D{m['tot']}", "fed", KG, 0.5), ("Produced kg", lambda m: f"E{m['tot']}", "prod", KG, 0.5), ("Yield", lambda m: "D4", "yield", '0.0000%', 0.00005),
        ("Loss", lambda m: "E4", "loss", '0.0000%', 0.00005), ("Waste kg", lambda m: "F4", "waste", KG1, 0.05), ("Waste %", lambda m: "G4", "waste_pct", '0.0000%', 0.00005),
        ("Fed price", lambda m: "H4", "fed_price", '"₱"0.0000', 0.005), ("Actual fed price", lambda m: "I4", "actual", '"₱"0.0000', 0.005), ("Resiko cost", lambda m: "J4", "uplift", '"₱"0.0000', 0.005),
        ("Resiko loss", lambda m: "K4", "resiko_loss", '0.0000%', 0.00005), ("PC cost", lambda m: "L4", "pc", '"₱"0.0000', 0.005), ("True PC cost", lambda m: "M4", "true_pc", '"₱"0.0000', 0.005),
        ("Fed kg in price set", lambda m: "N4", "incl_kg", KG, 0.5)]
rr = 5
for name, _, key in CAMPS:
    for lab, addr, k, fmt, tol in spec:
        src = f"{q(name)}!{addr(M[name])}"
        put(ws, f"A{rr}", name, f_base, al=LFT); put(ws, f"B{rr}", lab, f_base, al=LFT)
        put(ws, f"C{rr}", f'=IF({src}="","",{src})', f_link, fmt, None, R)
        put(ws, f"D{rr}", KPIS[key][k], f_in, fmt, None, R)
        put(ws, f"E{rr}", f'=IF(OR(C{rr}="",D{rr}=""),"",C{rr}-D{rr})', f_base, fmt.replace('"₱"', ''), None, R)
        put(ws, f"F{rr}", f'=IF(AND(C{rr}="",D{rr}=""),"OK (blank on purpose)",IF(OR(C{rr}="",D{rr}=""),"CHECK",IF(ABS(E{rr})<=G{rr},"OK","CHECK")))', f_bold, None, None, C)
        put(ws, f"G{rr}", tol, f_mut, "0.#####", None, R)
        rr += 1
for i, w in enumerate([18, 22, 16, 16, 14, 24, 11]): ws.column_dimensions[L(1 + i)].width = w
ws.freeze_panes = "A5"

wb.save("generated-v3.xlsx")  # written beside this script   # never overwrite Renzo's edited copy; print("saved", rr - 5, "check rows")
