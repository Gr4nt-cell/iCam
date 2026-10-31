async function buildICam() {
  const created=[];
  const fonts=await figma.listAvailableFontsAsync();
  const family=fonts.some(f=>f.fontName.family==='Roboto')?'Roboto':'Inter';
  const regular=fonts.find(f=>f.fontName.family===family&&f.fontName.style==='Regular').fontName;
  const medium=fonts.find(f=>f.fontName.family===family&&f.fontName.style==='Medium')?.fontName||regular;
  await Promise.all([figma.loadFontAsync(regular),figma.loadFontAsync(medium)]);
  const page=figma.createPage();page.name='iCam · Liquid Glass';await figma.setCurrentPageAsync(page);created.push(page.id);
  const keep=n=>{created.push(n.id);if('findAll' in n)created.push(...n.findAll(()=>true).map(c=>c.id));return n;};
  const rgb=hex=>({r:parseInt(hex.slice(1,3),16)/255,g:parseInt(hex.slice(3,5),16)/255,b:parseInt(hex.slice(5,7),16)/255});
  const solid=(hex,opacity=1)=>({type:'SOLID',color:rgb(hex),opacity});
  const collection=figma.variables.createVariableCollection('iCam / Camera');
  const vars={};
  for(const [name,value] of Object.entries({ink:'#ffffff',muted:'#c4d2df',accent:'#c2e9ff',canvas:'#07111f',surface:'#162638'})){
    const v=figma.variables.createVariable(name,collection,'COLOR');v.scopes=name==='canvas'||name==='surface'?['FRAME_FILL','SHAPE_FILL']:['TEXT_FILL','SHAPE_FILL','STROKE_COLOR'];v.setValueForMode(collection.defaultModeId,{...rgb(value),a:1});vars[name]=v;
  }
  const paint=name=>figma.variables.setBoundVariableForPaint(solid('#ffffff'),'color',vars[name]);
  const gradient=(a,b)=>({type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{...rgb(a),a:1}},{position:1,color:{...rgb(b),a:1}}]});
  function box(parent,name,w,h,x=0,y=0,glass=false){const n=keep(figma.createFrame());n.name=name;n.resize(w,h);n.x=x;n.y=y;n.fills=glass?[solid('#0f1822',.74),{...gradient('#ddf1ff','#a2d1ff'),opacity:.12}]:[];n.cornerRadius=glass?26:0;if(glass){n.strokes=[solid('#ddf1ff',.32)];n.strokeWeight=1;n.effects=[{type:'BACKGROUND_BLUR',radius:24,visible:true}];}parent.appendChild(n);return n;}
  function row(parent,name,w,h,x,y,gap=8){const n=box(parent,name,w,h,x,y);n.layoutMode='HORIZONTAL';n.primaryAxisSizingMode='FIXED';n.counterAxisSizingMode='FIXED';n.counterAxisAlignItems='CENTER';n.itemSpacing=gap;return n;}
  function text(parent,value,size=13,color='ink',x=0,y=0,w){const n=keep(figma.createText());n.name=value;n.fontName=size>=14?medium:regular;n.characters=value;n.fontSize=size;n.fills=[paint(color)];n.x=x;n.y=y;if(w){n.textAutoResize='HEIGHT';n.resize(w,size*1.4);}parent.appendChild(n);return n;}
  function shape(parent,name,w,h,x,y,fill,r=0){const n=keep(figma.createRectangle());n.name=name;n.resize(w,h);n.x=x;n.y=y;n.fills=[fill];n.cornerRadius=r;parent.appendChild(n);return n;}
  function icon(parent,key,size=22){const p=paths[key];const n=keep(figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 24 24"><path fill="#ffffff" d="'+p+'"/></svg>'));n.name='Icon / '+key;parent.appendChild(n);return n;}
  const board=box(page,'iCam / UI reference',1600,1120,100,100);board.fills=[solid('#080f1c')];
  text(board,'iCam',42,'ink',36,24);text(board,'LIQUID GLASS / CAMERA INTERFACE',12,'accent',38,82);
  text(board,'Photo, video and manual capture. Existing camera functions, renewed surfaces.',15,'muted',38,112);
  const library=box(page,'iCam / Control components',600,160,100,1260);
  const components={};let ci=0;
  for(const key of Object.keys(paths)){
    const c=keep(figma.createComponent());c.name='Control / '+key;c.description='iCam '+key+' control. Translucent cool glass; icon remains editable vector.';c.resize(44,44);c.cornerRadius=22;c.fills=[solid('#162638',.82),{...gradient('#ddf1ff','#a2d1ff'),opacity:.14}];c.strokes=[solid('#ddf1ff',.35)];c.strokeWeight=1;c.layoutMode='HORIZONTAL';c.primaryAxisAlignItems='CENTER';c.counterAxisAlignItems='CENTER';c.primaryAxisSizingMode='FIXED';c.counterAxisSizingMode='FIXED';icon(c,key);c.x=(ci%10)*58;c.y=Math.floor(ci/10)*64;ci++;library.appendChild(c);components[key]=c;
  }
  function button(parent,key,x,y,size=44){const n=keep(components[key].createInstance());parent.appendChild(n);n.resize(size,size);n.x=x;n.y=y;return n;}
  function chip(parent,label,w,h,x,y,active=false){const n=box(parent,label,w,h,x,y,true);n.cornerRadius=h/2;if(active)n.fills=[solid('#b9e2ff',.25)];const t=text(n,label,12,active?'accent':'ink');t.x=(w-t.width)/2;t.y=(h-t.height)/2;return n;}
  function lens(parent,y){const r=row(parent,'Lens selector',174,44,93,y,4);r.cornerRadius=22;r.fills=[solid('#0f1822',.72)];r.strokes=[solid('#ddf1ff',.30)];for(const label of ['0.5','1×','2','5']){const c=chip(r,label,38,36,0,0,label==='1×');}r.paddingLeft=5;}
  function modeRail(parent,active){const r=row(parent,'Scrollable capture modes',310,44,10,8,1);r.clipsContent=true;const labels=active==='Pro'?['Night Sight','Pro','Photo','Portrait']:active==='Video'?['Portrait','Video','Slo-mo','Dual']:['Pro','Photo','Portrait','Macro'];for(const label of labels){const c=box(r,label,label==='Night Sight'?87:70,36,0,0,label===active);c.cornerRadius=18;const t=text(c,label,13,label===active?'accent':'muted');t.x=(c.width-t.width)/2;t.y=9;}}
  function camera(label,x,active){const f=box(board,label,360,800,x,180);f.cornerRadius=36;f.clipsContent=true;f.fills=[gradient('#324f63','#07101d')];
    // Editable abstract live-view placeholder. It is not a captured photograph.
    const sky=shape(f,'Live view placeholder',360,800,0,0,gradient('#426e86','#122432'));
    for(const [w,h,l,t,c] of [[420,400,-160,270,'#314f5e'],[390,440,150,240,'#203d4c'],[420,330,-40,450,'#142e3c']]){shape(f,'Scene / abstract terrain',w,h,l,t,solid(c),180);}
    text(f,'9:41',12,'ink',24,14);text(f,'●  ▰',12,'ink',290,14);
    button(f,'flash',20,44);const top=row(f,'Timer and format',176,44,92,44,13);top.cornerRadius=22;top.fills=[solid('#0f1822',.72)];top.strokes=[solid('#ddf1ff',.3)];top.paddingLeft=14;icon(top,'timer',17);text(top,'OFF',12);text(top,active==='Video'?'4K · 30':'4:3',12);icon(top,'chevron',14);button(f,'settings',296,44);
    chip(f,active==='Video'?'● VIDEO  |  4K · 30':'● READY  |  4:3',155,32,22,100);text(f,'REAR CAMERA',9,'muted',260,110);
    if(active==='Video'){const r=box(f,'Recording status',100,34,130,148,true);r.fills=[solid('#932f34',.8)];text(r,'●  00:12',14,'ink',16,8);}
    // The persistent viewfinder guides mirror the source; no additional touch behavior.
    const grid=box(f,'Viewfinder grid',310,304,25,216);grid.strokes=[solid('#ffffff',.2)];for(const xx of [103,206])shape(grid,'Grid vertical',.6,304,xx,0,solid('#ffffff',.2));for(const yy of [101,202])shape(grid,'Grid horizontal',310,.6,0,yy,solid('#ffffff',.2));
    button(f,'plus',308,280,34);const rail=box(f,'Exposure rail',34,92,308,322,true);shape(rail,'Track',1,68,16,12,solid('#ffffff',.5));shape(rail,'Exposure marker',18,2,8,45,paint('accent'),1);button(f,'minus',308,422,34);
    lens(f,504);
    const dock=box(f,'Capture dock',332,210,14,558,true);dock.cornerRadius=38;modeRail(dock,active);
    button(dock,active==='Video'?'pause':'image',30,72,52);button(dock,'flip',250,70,56);
    const outer=box(dock,'Shutter / '+(active==='Video'?'stop recording':'take photo'),84,84,124,58,true);outer.cornerRadius=42;outer.strokes=[solid('#ffffff',.95)];outer.strokeWeight=1.5;
    shape(outer,active==='Video'?'Stop recording':'Photo shutter',active==='Video'?30:66,active==='Video'?30:66,active==='Video'?27:9,active==='Video'?27:9,solid(active==='Video'?'#ff3b30':'#f1f8ff'),active==='Video'?8:33);
    shape(dock,'Tool divider',280,.6,26,158,solid('#ddf1ff',.18));const quick=row(dock,'Quick tools',270,40,31,162,8);icon(quick,'palette',15);text(quick,'LOOK',10);text(quick,'NATURAL',9,'accent');shape(quick,'Divider',1,16,0,0,solid('#ffffff',.3));icon(quick,'settings',15);text(quick,active==='Pro'?'SETUP':'EXPOSURE',10);
    shape(f,'System home indicator',120,4,120,787,solid('#ffffff',.8),2);
    return f;
  }
  const photo=camera('01 / Photo',32,'Photo');const video=camera('02 / Recording',424,'Video');const pro=camera('03 / Pro',816,'Pro');
  const panel=box(pro,'Manual controls',332,140,14,346,true);text(panel,'ISO AUTO · 1/60 · WB AUTO',12,'ink',16,16);chip(panel,'PHOTO',64,28,250,10,true);const tabs=row(panel,'Manual tabs',300,34,16,48,12);for(const label of ['ISO','Shutter','WB','Focus','EV'])text(tabs,label,12,label==='ISO'?'accent':'muted');const values=row(panel,'ISO values',300,34,16,92,12);for(const label of ['Auto','100','200','400','800']){const c=chip(values,label,48,30,0,0,label==='Auto');}
  const settings=camera('04 / Settings',1208,'Photo');const sheet=box(settings,'Settings · scrollable',346,704,7,96,true);sheet.cornerRadius=32;sheet.clipsContent=true;sheet.fills=[solid('#0c1622',.96),{...gradient('#ddf1ff','#a2d1ff'),opacity:.05}];shape(sheet,'Grabber',40,5,153,10,solid('#ffffff',.4),3);text(sheet,'ICAM · PREFERENCES',10,'accent',20,38);text(sheet,'Make it yours.',30,'ink',20,58);button(sheet,'close',282,46);
  function section(y,title,label,hint,toggle=true,height=122){const c=box(sheet,title,306,height,20,y);c.cornerRadius=24;c.fills=[solid('#ddf1ff',.055)];c.strokes=[solid('#ddf1ff',.18)];text(c,title.toUpperCase(),10,'accent',16,14);text(c,label,14,'ink',16,42,210);text(c,hint,11,'muted',16,66,230);if(toggle){const sw=box(c,'Switch / on',38,23,252,40);sw.cornerRadius=12;sw.fills=[paint('accent')];shape(sw,'Switch thumb',19,19,17,2,solid('#ffffff'),10);}return c;}
  section(116,'Photo processing','Processing',"Single full-quality shot processed by your phone’s own image engine",false,132);
  const saved=section(264,'Saved settings','Remember settings','Keep mode, filters and Pro values next time',true,150);text(saved,'Reset everything to defaults',12,'muted',16,116);
  section(430,'Sound','Capture sound','Shutter click and video start / stop tones',true,118);
  section(564,'Hands-free shutter','Palm shutter','Raise an open hand to start a 3-second timer',true,122);
  text(board,'Design reference — abstract live-view placeholders; camera output is never tinted by the UI.',12,'muted',36,1010);
  text(board,'All modes retained: Night Sight · Pro · Photo · Portrait · Macro · Video · Slo-mo · Dual · Action',12,'accent',36,1040);
  figma.viewport.scrollAndZoomIntoView([board]);
  return {boardId:board.id,createdNodeIds:created,screenCount:4,componentCount:Object.keys(components).length,variableCount:Object.keys(vars).length,images:0,collectionId:collection.id,variableIds:Object.values(vars).map(v=>v.id)};
}
const paths={"flash":"M17,10H13L17,2H7V4.18L15.46,12.64M3.27,3L2,4.27L7,9.27V13H10V22L13.58,15.86L17.73,20L19,18.73L3.27,3Z","timer":"M12,20A7,7 0 0,1 5,13A7,7 0 0,1 12,6A7,7 0 0,1 19,13A7,7 0 0,1 12,20M19.03,7.39L20.45,5.97C20,5.46 19.55,5 19.04,4.56L17.62,6C16.07,4.74 14.12,4 12,4A9,9 0 0,0 3,13A9,9 0 0,0 12,22C17,22 21,17.97 21,13C21,10.88 20.26,8.93 19.03,7.39M11,14H13V8H11M15,1H9V3H15V1Z","settings":"M8 13C6.14 13 4.59 14.28 4.14 16H2V18H4.14C4.59 19.72 6.14 21 8 21S11.41 19.72 11.86 18H22V16H11.86C11.41 14.28 9.86 13 8 13M8 19C6.9 19 6 18.1 6 17C6 15.9 6.9 15 8 15S10 15.9 10 17C10 18.1 9.1 19 8 19M19.86 6C19.41 4.28 17.86 3 16 3S12.59 4.28 12.14 6H2V8H12.14C12.59 9.72 14.14 11 16 11S19.41 9.72 19.86 8H22V6H19.86M16 9C14.9 9 14 8.1 14 7C14 5.9 14.9 5 16 5S18 5.9 18 7C18 8.1 17.1 9 16 9Z","flip":"M20 5H16.83L15 3H9L7.17 5H4C2.9 5 2 5.9 2 7V19C2 20.11 2.9 21 4 21H20C21.11 21 22 20.11 22 19V7C22 5.9 21.11 5 20 5M20 19H4V7H8.05L9.88 5H14.12L16 7H20V19M5 12H7.1C7.65 9.29 10.29 7.55 13 8.1C13.76 8.25 14.43 8.59 15 9L13.56 10.45C13.11 10.17 12.58 10 12 10C10.74 10 9.6 10.8 9.18 12H11L8 15L5 12M16.91 14C16.36 16.71 13.72 18.45 11 17.9C10.25 17.74 9.58 17.41 9 17L10.44 15.55C10.9 15.83 11.43 16 12 16C13.27 16 14.41 15.2 14.83 14H13L16 11L19 14H16.91Z","image":"M19,19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M13.96,12.29L11.21,15.83L9.25,13.47L6.5,17H17.5L13.96,12.29Z","palette":"M12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2C17.5,2 22,6 22,11A6,6 0 0,1 16,17H14.2C13.9,17 13.7,17.2 13.7,17.5C13.7,17.6 13.8,17.7 13.8,17.8C14.2,18.3 14.4,18.9 14.4,19.5C14.5,20.9 13.4,22 12,22M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C12.3,20 12.5,19.8 12.5,19.5C12.5,19.3 12.4,19.2 12.4,19.1C12,18.6 11.8,18.1 11.8,17.5C11.8,16.1 12.9,15 14.3,15H16A4,4 0 0,0 20,11C20,7.1 16.4,4 12,4M6.5,10C7.3,10 8,10.7 8,11.5C8,12.3 7.3,13 6.5,13C5.7,13 5,12.3 5,11.5C5,10.7 5.7,10 6.5,10M9.5,6C10.3,6 11,6.7 11,7.5C11,8.3 10.3,9 9.5,9C8.7,9 8,8.3 8,7.5C8,6.7 8.7,6 9.5,6M14.5,6C15.3,6 16,6.7 16,7.5C16,8.3 15.3,9 14.5,9C13.7,9 13,8.3 13,7.5C13,6.7 13.7,6 14.5,6M17.5,10C18.3,10 19,10.7 19,11.5C19,12.3 18.3,13 17.5,13C16.7,13 16,12.3 16,11.5C16,10.7 16.7,10 17.5,10Z","plus":"M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z","minus":"M19,13H5V11H19V13Z","close":"M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z","pause":"M14,19H18V5H14M6,19H10V5H6V19Z","chevron":"M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z","moon":"M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z"};
console.log(await buildICam());
