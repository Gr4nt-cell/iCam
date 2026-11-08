import React, {useCallback,useEffect,useState} from 'react';
import {Alert,AppState,Linking,Modal,Pressable,ScrollView,StyleSheet,Text,View,useWindowDimensions} from 'react-native';
import {MaterialCommunityIcons} from '@expo/vector-icons';
import {getCameraDisplays,moveCameraDisplay,requestRearDisplayAccess,type CameraDisplays} from '../../modules/icamera';
import type {CaptureMode,Lens} from '../camera/hardware';
import {Glass} from './Glass';
import {Slider} from './Controls';
import {LinearGradient} from 'expo-linear-gradient';
import {rearCameraFrame} from '../camera/rearLayout';

export function useCameraScreens(locked: boolean,notify: (message: string)=>void) {
  const [status,setStatus]=useState<CameraDisplays|null>(null);
  const [open,setOpen]=useState(false);
  const [switching,setSwitching]=useState(false);
  const [rootEnabled,setRootEnabled]=useState(false);
  const [pendingTarget,setPendingTarget]=useState<number|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const dimensions=useWindowDimensions();
  const refresh=useCallback(()=>{getCameraDisplays().then(setStatus).catch(()=>undefined)},[]);
  useEffect(()=>{refresh();const subscription=AppState.addEventListener('change',s=>{if(s==='active')refresh()});return()=>subscription.remove()},[refresh,dimensions.width,dimensions.height]);
  useEffect(()=>{if(status&&!status.displays.some(d=>d.isRear))setOpen(false)},[status]);
  useEffect(()=>{if(!open)return;const id=setInterval(refresh,1500);return()=>clearInterval(id)},[open,refresh]);
  const move=async(target: number,privileged: boolean,root=rootEnabled)=>{
    if(locked||switching)return;
    setSwitching(true);setMessage(null);setPendingTarget(target);
    try{
      const result=await moveCameraDisplay(target,privileged,root);
      refresh();
      if(result.moved){setOpen(false);notify(target===0?'Camera on front screen':'Camera on rear screen')}
      else {setOpen(true);const text=result.message||'This screen is restricted. Enable Shizuku access below.';setMessage(text);notify(text);}
    }catch(e){setOpen(true);const text=e instanceof Error?e.message:'Screen switch failed';setMessage(text);notify(text)}
    finally{setSwitching(false);refresh()}
  };
  const authorize=async()=>{
    try{const state=await requestRearDisplayAccess();
      if(state==='notRunning')Alert.alert('Rear screen access','Start Shizuku with wireless debugging, then allow iCam access. It is only used to move iCam between screens.',[
        {text:'Cancel',style:'cancel'},{text:'Shizuku guide',onPress:()=>{Linking.openURL('https://shizuku.rikka.app/guide/setup/').catch(()=>notify('Could not open the guide'))}}]);
      else if(state==='denied')notify('Allow iCam in Shizuku’s authorised apps, then return here.');
      else notify(state==='granted'?'Shizuku connected':'Allow the Shizuku prompt, then choose the screen again.');
      refresh();
    }catch{notify('Shizuku access is unavailable')}
  };
  return {status,open,setOpen,switching,message,refresh,move,authorize,rootEnabled,
    useRoot:()=>{const target=pendingTarget ?? status?.displays.find(d=>d.id!==0)?.id;if(target===undefined)return;setRootEnabled(true);move(target,!!status?.shizukuGranted,true)},onSecondary:!!status&&status.displays.some(d=>d.id===status.currentId&&d.isRear),available:!!status&&status.displays.some(d=>d.isRear)};
}

export function CameraScreenPicker({screens,locked}:{screens:ReturnType<typeof useCameraScreens>;locked:boolean}) {
  return <Modal visible={screens.open} transparent animationType="fade" onRequestClose={()=>screens.setOpen(false)}>
    <View style={s.scrim}><Glass radius={24} style={s.sheet}>
      <ScrollView contentContainerStyle={{padding:16,gap:10}}>
        <View style={s.heading}><Text style={s.title}>Camera screen</Text><Pressable accessibilityLabel="Close screen selector" onPress={()=>screens.setOpen(false)} style={s.close}><Text style={s.white}>×</Text></Pressable></View>
        <Text style={s.hint}>Move the camera interface between screens. The screen button is separate from the camera-lens flip.</Text>
        {locked&&<Text style={s.accent}>Finish recording or saving before switching.</Text>}
        {!!screens.message&&<Text style={s.accent}>{screens.message}</Text>}
        {screens.status?.displays.map(d=><Pressable key={d.id} disabled={locked||screens.switching||d.id===screens.status?.currentId}
          accessibilityRole="button" onPress={()=>screens.move(d.id,!!screens.status?.shizukuGranted)}
          style={[s.row,d.id===screens.status?.currentId&&s.active]}>
          <Text style={s.white}>{d.id===0?'Front screen':`${d.name} · ${d.width} × ${d.height}`}</Text>
          <Text style={s.accent}>{d.id===screens.status?.currentId?'Current':screens.switching?'…':'Move →'}</Text>
        </Pressable>)}
        <Text style={s.hint}>Some HyperOS versions restrict the rear screen. If Android blocks switching, use Shizuku or the root fallback. Both move only iCam’s own task.</Text>
        <Pressable disabled={locked||screens.switching} onPress={screens.authorize} style={s.row}><Text style={s.white}>{screens.status?.shizukuGranted?'Shizuku connected':'Enable Shizuku access'}</Text></Pressable>
        {screens.status?.systemAccess&&<Text style={s.accent}>Privileged system access is granted.</Text>}
        <Pressable disabled={locked||screens.switching} onPress={screens.useRoot} style={s.row}><Text style={s.white}>{screens.rootEnabled?'Root fallback enabled':'Use root fallback'}</Text></Pressable>
        <Text style={s.hint}>The root manager may ask for approval. A properly provisioned privileged system app uses its task permission without Shizuku or root.</Text>
        <Text style={s.hint}>Keep the phone unlocked and enable its rear screen in system settings. No rear-screen timeout or other app settings are changed.</Text>
      </ScrollView>
    </Glass></View>
  </Modal>;
}

export function RearCameraBackdrop(){return <LinearGradient colors={['#95958d','#9b826e','#343536']} style={StyleSheet.absoluteFill} />}

export function RearCameraControls(p:{
  mode:CaptureMode;video:boolean;modes:{key:string;label:string}[];recording:boolean;paused:boolean;busy:boolean;locked:boolean;
  countdown:number;stops:Lens[];zoomLabel:string;onMode:(mode:CaptureMode)=>void;onLens:(lens:Lens)=>void;
  onShutter:()=>void;onFlip:()=>void;onScreens:()=>void;onPause:()=>void;onGallery:()=>void;canFlip:boolean;toast:string|null;
  skin:number;onSkin:(value:number)=>void;
}){
  const {width,height}=useWindowDimensions();const frame=rearCameraFrame(width,height);
  const rail=width-frame.left-frame.width;const size=Math.min(72,Math.max(44,rail-10));
  const button=Math.min(44,Math.max(30,height*.1));const gap=Math.min(10,Math.max(4,height*.015));
  const [beauty,setBeauty]=useState(false);
  const mainModes=['video','photo','portrait','action'];
  const modes=p.modes.filter(m=>mainModes.includes(m.key)||m.key===p.mode).sort((a,b)=>mainModes.indexOf(a.key)-mainModes.indexOf(b.key));
  const nextLens=()=>{if(!p.stops.length)return;const i=p.stops.findIndex(s=>s.label===p.zoomLabel);p.onLens(p.stops[(i+1+p.stops.length)%p.stops.length])};
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    <Pressable accessibilityRole="button" accessibilityLabel="Return camera to front screen" disabled={p.locked} onPress={p.onScreens}
      style={[s.front,{left:frame.left+frame.width/2-22},p.locked&&s.dim]}><MaterialCommunityIcons name="chevron-down" size={30} color="#fff"/></Pressable>
    <View pointerEvents="box-none" style={[s.xiaomiRail,{width:rail,gap}]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open last capture" disabled={p.locked} onPress={p.onGallery} style={[s.round,{width:button,height:button},p.locked&&s.dim]}><MaterialCommunityIcons name="image-outline" size={23} color="#fff"/></Pressable>
      <View style={{flex:1}}/>
      <Pressable accessibilityRole="button" accessibilityLabel="Change rear camera zoom" accessibilityHint="Long press to switch camera" disabled={p.busy} onPress={nextLens} onLongPress={()=>{if(p.canFlip&&!p.recording)p.onFlip()}} style={[s.round,{width:button,height:button}]}><Text style={s.white}>{p.zoomLabel}×</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={p.recording?(p.paused?'Resume recording':'Pause recording'):'Face smoothing'} disabled={p.busy} onPress={()=>p.recording?p.onPause():setBeauty(v=>!v)} style={[s.round,{width:button,height:button}]}><MaterialCommunityIcons name={p.recording?(p.paused?'play':'pause'):'auto-fix'} size={23} color="#ffd63b"/></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={p.recording?'Stop recording':'Capture'} disabled={p.busy} onPress={p.onShutter} style={[s.shutter,{width:size,height:size,borderRadius:size/2},p.busy&&s.dim]}><View style={[{width:size-10,height:size-10,borderRadius:(size-10)/2,backgroundColor:p.video?'#ff3b30':'#fff'},p.recording&&s.stop]}/></Pressable>
    </View>
    <View style={[s.modeBottom,{left:Math.max(8,frame.left+8),right:rail+4}]}>
      {!!p.toast&&<Text numberOfLines={2} style={s.toast}>{p.toast}</Text>}
      {p.countdown>0&&<Text style={s.countdown}>{p.countdown}</Text>}
      {beauty&&<Glass radius={14} style={{padding:10,gap:5}}><Text style={s.white}>Skin {Math.round(p.skin*100)}</Text><Slider value={p.skin} min={0} max={1} onChange={p.onSkin}/></Glass>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.modeLabels}>
        {modes.map(m=><Pressable key={m.key} disabled={p.recording||p.busy} onPress={()=>p.onMode(m.key as CaptureMode)} style={s.modeLabel}><Text style={[s.modeText,p.mode===m.key&&{color:'#ffd63b',fontWeight:'600'}]}>{m.label}</Text></Pressable>)}
      </ScrollView>
    </View>
  </View>;
}
const s=StyleSheet.create({
  scrim:{flex:1,justifyContent:'center',alignItems:'center',backgroundColor:'rgba(0,0,0,.62)',padding:8},sheet:{width:'100%',maxWidth:430,maxHeight:'96%'},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  title:{color:'#fff',fontSize:18,fontWeight:'700'},close:{padding:10},hint:{color:'#ccc',fontSize:12,lineHeight:17},white:{color:'#fff',fontSize:12},accent:{color:'#ffe16b',fontSize:12,fontWeight:'600'},row:{padding:12,borderRadius:16,backgroundColor:'rgba(255,255,255,.08)',gap:5},active:{backgroundColor:'rgba(255,225,107,.20)'},
  front:{position:'absolute',top:2,width:44,minHeight:40,alignItems:'center',justifyContent:'center'},xiaomiRail:{position:'absolute',right:0,top:8,bottom:8,alignItems:'center'},round:{borderRadius:40,backgroundColor:'rgba(10,10,10,.68)',alignItems:'center',justifyContent:'center'},
  shutter:{borderColor:'#fff',borderWidth:2,alignItems:'center',justifyContent:'center'},stop:{width:22,height:22,borderRadius:5},dim:{opacity:.4},modeBottom:{position:'absolute',bottom:2,gap:6},modeLabels:{alignItems:'center',gap:2},modeLabel:{minHeight:38,paddingHorizontal:10,alignItems:'center',justifyContent:'center'},modeText:{fontSize:13,color:'#fff',textShadowColor:'rgba(0,0,0,.6)',textShadowRadius:2},
  toast:{color:'#fff',backgroundColor:'rgba(0,0,0,.7)',fontSize:11,padding:5,borderRadius:8},countdown:{color:'#fff',fontSize:28,textAlign:'center'},
});
