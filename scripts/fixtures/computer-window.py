import gi,json,sys
from pathlib import Path
gi.require_version('Gtk','3.0');from gi.repository import Gtk,GLib,GdkX11
w=Gtk.Window(title='ComputerUseFixture');w.set_default_size(480,240)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL);w.add(box)
e=Gtk.Entry();e.set_property('im-module','gtk-im-context-simple');b=Gtk.Button(label='Apply fixture');label=Gtk.Label(label='Synthetic fixture only')
box.pack_start(e,True,True,0);box.pack_start(b,True,True,0);box.pack_start(label,True,True,0)
b.connect('clicked',lambda _:Path(sys.argv[1]+'/receipt.json').write_text(json.dumps({'text':e.get_text(),'clicked':True})))
w.connect('destroy',Gtk.main_quit);w.show_all()
def ready():
 def rect(widget):
  a=widget.get_allocation();return {'x':a.x+a.width//2,'y':a.y+a.height//2}
 Path(sys.argv[1]+'/ready.json').write_text(json.dumps({'id':str(w.get_window().get_xid()),'entry':rect(e),'button':rect(b)}));return False
GLib.idle_add(ready);Gtk.main()
