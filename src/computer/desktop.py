#!/usr/bin/python3
"""Selected X11/XWayland window only. No clipboard, shell, global capture or key logging."""
import os, sys, json, base64, ctypes, ctypes.util, re, atexit, signal
os.environ['GDK_BACKEND'] = 'x11'
import gi
gi.require_version('Gdk', '3.0'); gi.require_version('GdkX11', '3.0')
from gi.repository import Gdk, GdkX11
from pathlib import Path
BLOCKED_CLASS = json.loads(Path(__file__).with_name('window-policy.json').read_text())['blockedClassPattern']
Gdk.init([])
def stopped(signum, frame): raise RuntimeError('已停止桌面操作')
signal.signal(signal.SIGTERM, stopped)

def main(m):
    display = Gdk.Display.get_default()
    if not display or not isinstance(display, GdkX11.X11Display): raise RuntimeError('需要可用的 X11／XWayland 顯示服務；原生 Wayland 視窗不支援。')
    windows = Gdk.Screen.get_default().get_window_stack() or []
    lib = ctypes.CDLL(ctypes.util.find_library('X11'))
    lib.XOpenDisplay.restype=ctypes.c_void_p; pd=lib.XOpenDisplay(None)
    if not pd: raise RuntimeError('無法讀取 X11 視窗屬性。')
    lib.XCloseDisplay.argtypes=[ctypes.c_void_p]; atexit.register(lambda:lib.XCloseDisplay(pd))
    lib.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int];lib.XInternAtom.restype=ctypes.c_ulong
    lib.XGetWindowProperty.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_long,ctypes.c_long,ctypes.c_int,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    lib.XFree.argtypes=[ctypes.c_void_p]
    def prop(w, name, kind):
        actual=ctypes.c_ulong();fmt=ctypes.c_int();n=ctypes.c_ulong();remaining=ctypes.c_ulong();data=ctypes.POINTER(ctypes.c_ubyte)()
        atom=lib.XInternAtom(pd,name.encode(),False);typ=lib.XInternAtom(pd,kind.encode(),False)
        lib.XGetWindowProperty(pd,w.get_xid(),atom,0,4096,False,typ,ctypes.byref(actual),ctypes.byref(fmt),ctypes.byref(n),ctypes.byref(remaining),ctypes.byref(data))
        try:return ctypes.string_at(data,n.value).decode('utf-8','replace') if data and fmt.value==8 else ''
        finally:
            if data:lib.XFree(data)
    def info(w):
        g = w.get_geometry(); ok, x, y = w.get_origin()
        return {'class': prop(w,'WM_CLASS','STRING'), 'id': str(w.get_xid()), 'title': prop(w,'_NET_WM_NAME','UTF8_STRING'), 'width': g.width, 'height': g.height, 'x': x, 'y': y}
    if m['op'] == 'list': return {'windows': [info(w) for w in windows if w.is_viewable()]}
    w = next((w for w in windows if str(w.get_xid()) == str(m.get('id'))), None)
    if not w or not w.is_viewable(): raise RuntimeError('選定視窗已關閉或不可見。')
    current = info(w)
    if re.search(BLOCKED_CLASS,current['class'],re.I) or re.search(r'\b(?:sso|sign.?in|log.?in)\b|登入|驗證碼',current['title'],re.I): raise RuntimeError('登入、日常瀏覽器與終端機視窗不開放桌面控制；網頁請使用獨立工作瀏覽器。')
    if current['width'] > 3072 or current['height'] > 2048: raise RuntimeError('視窗過大，請縮小到 3072×2048 以內。')
    if m['op'] == 'observe':
        pixbuf = Gdk.pixbuf_get_from_window(w, 0, 0, current['width'], current['height'])
        if pixbuf is None: raise RuntimeError('無法擷取選定視窗。')
        ok, image = pixbuf.save_to_bufferv('png', [], [])
        if not ok or len(image) > 8 * 1024 * 1024: raise RuntimeError('截圖過大或擷取失敗。')
        return dict(current, png=base64.b64encode(image).decode('ascii'))
    if m['op'] != 'action': raise RuntimeError('未知桌面操作。')
    for key in ['x', 'y', 'width', 'height']:
        if current[key] != m['geometry'][key]: raise RuntimeError('視窗位置或大小已變更，請重新觀察。')
    x = ctypes.CDLL(ctypes.util.find_library('X11')); xt = ctypes.CDLL(ctypes.util.find_library('Xtst'))
    x.XOpenDisplay.restype = ctypes.c_void_p; d = x.XOpenDisplay(None)
    if not d: raise RuntimeError('無法連接 X11。')
    U = ctypes.c_ulong; I = ctypes.c_int; P = ctypes.c_void_p
    for lib, name, args in [(x,'XCloseDisplay',[P]),(x,'XSync',[P,I]),(x,'XSetInputFocus',[P,U,I,U]),(x,'XGetInputFocus',[P,ctypes.POINTER(U),ctypes.POINTER(I)]),
       (x,'XQueryTree',[P,U,ctypes.POINTER(U),ctypes.POINTER(U),ctypes.POINTER(ctypes.POINTER(U)),ctypes.POINTER(ctypes.c_uint)]),(x,'XFree',[P]),
       (x,'XQueryPointer',[P,U,ctypes.POINTER(U),ctypes.POINTER(U),ctypes.POINTER(I),ctypes.POINTER(I),ctypes.POINTER(I),ctypes.POINTER(I),ctypes.POINTER(ctypes.c_uint)]),
       (xt,'XTestFakeMotionEvent',[P,I,I,I,U]),(xt,'XTestFakeButtonEvent',[P,ctypes.c_uint,I,U]),(xt,'XTestFakeKeyEvent',[P,ctypes.c_uint,I,U])]: getattr(lib,name).argtypes = args
    def ancestors(window):
        result = []
        for _ in range(20):
            result.append(window); root=U(); parent=U(); children=ctypes.POINTER(U)(); count=ctypes.c_uint()
            if not x.XQueryTree(d,window,ctypes.byref(root),ctypes.byref(parent),ctypes.byref(children),ctypes.byref(count)): break
            if children: x.XFree(children)
            if not parent.value or parent.value == window: break
            window=parent.value
        return result
    held_keys=set();held_buttons=set()
    try:
        action = m['action']; keymap=Gdk.Keymap.get_for_display(display)
        def key(value):
            symbol = Gdk.keyval_from_name(value) if len(value)>1 else Gdk.unicode_to_keyval(ord(value))
            ok, entries = keymap.get_entries_for_keyval(symbol)
            entry = next((e for e in entries if e.group == 0 and e.level in (0,1)), None) if ok else None
            if not entry: raise RuntimeError('此字元不在目前鍵盤映射；請改用瀏覽器文字工具或手動輸入。')
            return entry.keycode, entry.level
        keys = []
        if action == 'type':
            text=m.get('text','')
            if not isinstance(text,str) or not 1 <= len(text) <= 1000 or any(ord(c)<32 for c in text): raise RuntimeError('文字需為 1–1000 個可列印字元。')
            keys=[key(c) for c in text]
        elif action == 'key':
            if m.get('key') not in ['Return','Tab','Escape','space','BackSpace','Delete','Left','Right','Up','Down','Home','End','Page_Up','Page_Down']: raise RuntimeError('不允許此按鍵或系統快捷鍵。')
            keys=[key(m['key'])]
        elif action not in ['click','scroll']: raise RuntimeError('未知桌面動作。')
        w.raise_(); w.focus(Gdk.CURRENT_TIME); Gdk.Display.get_default().sync()
        x.XSetInputFocus(d, int(m['id']), 2, 0); x.XSync(d, False)
        focus=U(); revert=I(); x.XGetInputFocus(d,ctypes.byref(focus),ctypes.byref(revert))
        if int(m['id']) not in ancestors(focus.value): raise RuntimeError('焦點不在選定視窗，已停止操作。')
        root=U(); child=U(); rx=I(); ry=I(); wx=I(); wy=I(); mask=ctypes.c_uint()
        x.XQueryPointer(d,Gdk.get_default_root_window().get_xid(),ctypes.byref(root),ctypes.byref(child),ctypes.byref(rx),ctypes.byref(ry),ctypes.byref(wx),ctypes.byref(wy),ctypes.byref(mask))
        if mask.value & 0xed: raise RuntimeError('請先放開 Shift／Ctrl／Alt／Super 等修飾鍵，再重新觀察操作。')
        if action in ['click','scroll']:
            px=m.get('x'); py=m.get('y')
            if not isinstance(px,int) or not isinstance(py,int) or not 0<=px<current['width'] or not 0<=py<current['height']: raise RuntimeError('座標不在選定視窗內。')
            xt.XTestFakeMotionEvent(d,-1,current['x']+px,current['y']+py,0); x.XSync(d,False)
            root=U(); child=U(); rx=I(); ry=I(); wx=I(); wy=I(); mask=ctypes.c_uint()
            x.XQueryPointer(d,Gdk.get_default_root_window().get_xid(),ctypes.byref(root),ctypes.byref(child),ctypes.byref(rx),ctypes.byref(ry),ctypes.byref(wx),ctypes.byref(wy),ctypes.byref(mask))
            own=set(ancestors(int(m['id']))[:-1]); under=set(ancestors(child.value)[:-1]) if child.value else set()
            if not own.intersection(under): raise RuntimeError('選定視窗被其他視窗遮住，已停止操作。')
            button=1 if action=='click' else (4 if m.get('direction')=='up' else 5)
            count=1 if action=='click' else max(1,min(10,int(m.get('count',3))))
            for _ in range(count):
                held_buttons.add(button); xt.XTestFakeButtonEvent(d,button,True,0); xt.XTestFakeButtonEvent(d,button,False,0); held_buttons.discard(button)
        else:
            shift=key('Shift_L')[0]
            for code,level in keys:
                if level: held_keys.add(shift); xt.XTestFakeKeyEvent(d,shift,True,0)
                try: held_keys.add(code); xt.XTestFakeKeyEvent(d,code,True,0); xt.XTestFakeKeyEvent(d,code,False,0); held_keys.discard(code)
                finally:
                    if level: xt.XTestFakeKeyEvent(d,shift,False,0); held_keys.discard(shift)
        x.XSync(d,False); return {'performed': True, 'requiresObservation': True}
    finally:
        for code in held_keys: xt.XTestFakeKeyEvent(d,code,False,0)
        for button in held_buttons: xt.XTestFakeButtonEvent(d,button,False,0)
        x.XSync(d,False); x.XCloseDisplay(d)
try: print(json.dumps({'ok':True,**main(json.loads(sys.stdin.read(16000)))}))
except Exception as e: print(json.dumps({'ok':False,'error':str(e)})); sys.exit(1)
