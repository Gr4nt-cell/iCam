const record=(value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const finite=(value:unknown):value is number => typeof value==='number' && Number.isFinite(value);
const bound=(value:unknown,fallback:number,min:number,max:number) => finite(value)?Math.max(min,Math.min(max,value)):fallback;

/** JSON shape validation keeps restored values safe to pass across the native camera bridge. */
export function savedPreferences(value:unknown):Record<string,unknown>|null {
  if(!record(value))return null;
  const out:Record<string,unknown>={};
  for(const key of ['remember','mirrorSelfie','videoV2','palmShutter','shutterSound'])if(typeof value[key]==='boolean')out[key]=value[key];
  const choices:Record<string,unknown[]>={mode:['photo','portrait','pro','night','macro','video','action','dual','slowmo','pvideo'],filter:['natural','mono'],aspect:['4:3','16:9','1:1','full'],galleryPref:['viewer','gallery','ask'],flash:['off','on','auto'],timer:[0,3,10]};
  for(const [key,allowed] of Object.entries(choices))if(allowed.includes(value[key]))out[key]=value[key];
  for(const key of ['smoothing','photoSmoothing','bokeh'])if(finite(value[key]))out[key]=bound(value[key],0,0,1);
  for(const key of ['brightness','shadows'])if(finite(value[key]))out[key]=bound(value[key],0,-1,1);
  if(record(value.video)){
    const video=value.video,clean:Record<string,unknown>={};
    for(const [key,allowed] of Object.entries({resolution:['1080p','4k'],fps:[30,60],stabilization:['off','standard','cinematic','horizon'],antibanding:['country','auto','50','60','off']}))if((allowed as unknown[]).includes(video[key]))clean[key]=video[key];
    if(typeof video.hdr==='boolean')clean.hdr=video.hdr;
    out.video=clean;
  }
  if(record(value.photo)){
    const photo=value.photo,clean:Record<string,unknown>={};
    if(finite(photo.frames))clean.frames=Math.round(bound(photo.frames,4,1,6));
    for(const key of ['vendorNight','highlightBracket'])if(typeof photo[key]==='boolean')clean[key]=photo[key];
    out.photo=clean;
  }
  if(record(value.pip))out.pip={x:bound(value.pip.x,.74,0,1),y:bound(value.pip.y,.22,0,1),size:bound(value.pip.size,.34,.2,.6)};
  if(record(value.manual)){
    const manual=value.manual;
    out.manual={iso:Math.round(bound(manual.iso,0,0,1000000)),shutterNs:Math.round(bound(manual.shutterNs,0,0,60000000000)),kelvin:bound(manual.kelvin,5600,1000,15000),focusDistance:bound(manual.focusDistance,-1,-1,100),ev:bound(manual.ev,0,-2,2),whiteBalance:['auto','daylight','cloudy','shade','tungsten','fluorescent','twilight','kelvin'].includes(String(manual.whiteBalance))?manual.whiteBalance:'auto'};
  }
  return out;
}

export function devicePreferences(value:unknown):{weakGpu?:boolean} {
  return record(value) && typeof value.weakGpu==='boolean' ? {weakGpu:value.weakGpu}:{};
}
