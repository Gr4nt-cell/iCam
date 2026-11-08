import React, {useCallback,useEffect,useState} from 'react';
import {Alert,AppState,Linking,Modal,Pressable,ScrollView,StyleSheet,Text,View,useWindowDimensions} from 'react-native';
import {MaterialCommunityIcons} from '@expo/vector-icons';
import {getCameraDisplays,moveCameraDisplay,requestRearDisplayAccess,type CameraDisplays} from '../../modules/icamera';
import type {CaptureMode,Lens} from '../camera/hardware';
import {Glass} from './Glass';

export function useCameraScreens(locked: boolean,notify: (message: string)=>void) {
  const [status,setStatus]=useState<CameraDisplays|null>(null);
  const [open,setOpen]=useState(false);
  const [switching,setSwitching]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const dimensions=useWindowDimensions();
  const refresh=useCallback(()=>{getCameraDisplays().then(setStatus).catch(()=>undefined)},[]);
  useEffect(()=>{refresh();const subscription=AppState.addEventListener('change',s=>{if(s==='active')refresh()});return()=>subscription.remove()},[refresh,dimensions.width,dimensions.height]);
  useEffect(()=>{if(!open)return;const id=setInterval(refresh,1500);return()=>clearInterval(id)},[open,refresh]);
  const move=async(target: number,privileged: boolean)=>{
    if(locked||switching)return;
    setSwitching(true);setMessage(null);
    try{
      const result=await moveCameraDisplay(target,privileged);
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
  return {status,open,setOpen,switching,message,refresh,move,authorize,onSecondary:!!status&&status.currentId!==0,available:!!status&&status.displays.some(d=>d.id!==0)};
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
        <Text style={s.hint}>Some HyperOS versions restrict the rear screen. If Android blocks switching, connect Shizuku. It can move only iCam’s own task.</Text>
        <Pressable disabled={locked||screens.switching} onPress={screens.authorize} style={s.row}><Text style={s.white}>{screens.status?.shizukuGranted?'Shizuku connected':'Enable Shizuku access'}</Text></Pressable>
        <Text style={s.hint}>Keep the phone unlocked and enable its rear screen in system settings. No rear-screen timeout or other app settings are changed.</Text>
      </ScrollView>
    </Glass></View>
  </Modal>;
}

export function RearCameraControls(p:{
  mode:CaptureMode; video:boolean; modes:{key:string;label:string}[]; recording:boolean;paused:boolean;busy:boolean;locked:boolean;
  countdown:number;stops:Lens[];onMode:(mode:CaptureMode)=>void;onLens:(lens:Lens)=>void;
  onShutter:()=>void;onFlip:()=>void;onScreens:()=>void;onPause:()=>void;canFlip:boolean;toast:string|null;
}) {
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    <View pointerEvents="none" style={s.rearHeader}><Text style={s.brand}>iCam</Text><Text style={s.accent}>{p.recording?(p.paused?'PAUSED':'● REC'):p.mode.toUpperCase()}</Text></View>
    <Glass radius={30} style={s.rail}>
      <Pressable accessibilityRole="button" accessibilityLabel="Move camera to front screen" disabled={p.locked} onPress={p.onScreens} style={[s.icon,p.locked&&s.dim]}><MaterialCommunityIcons name="monitor-cellphone" size={22} color="#fff"/><Text style={s.small}>FRONT</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={p.recording?'Stop recording':'Capture'} disabled={p.busy} onPress={p.onShutter} style={[s.shutter,p.busy&&s.dim]}>
        <View style={[s.inner,(p.recording||p.video)&&s.red,p.recording&&s.stop]}/>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={p.recording?(p.paused?'Resume recording':'Pause recording'):'Flip camera lens'} disabled={p.recording?false:!p.canFlip||p.busy} onPress={p.recording?p.onPause:p.onFlip} style={s.icon}>
        <MaterialCommunityIcons name={p.recording?(p.paused?'play':'pause'):'camera-flip-outline'} size={24} color="#fff"/>
      </Pressable>
    </Glass>
    <View style={s.bottom} pointerEvents="box-none">
      {!!p.toast&&<Text numberOfLines={2} style={s.toast}>{p.toast}</Text>}
      {p.countdown>0&&<Text style={s.countdown}>{p.countdown}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        {p.stops.slice(0,4).map((lens,i)=><Pressable accessibilityRole="button" accessibilityLabel={`${lens.label} times zoom`} key={i} disabled={p.busy} onPress={()=>p.onLens(lens)} style={s.chip}><Text style={s.white}>{lens.label}×</Text></Pressable>)}
      </ScrollView>
      <Glass radius={23}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        {p.modes.map(m=><Pressable key={m.key} disabled={p.recording||p.busy} onPress={()=>p.onMode(m.key as CaptureMode)} style={[s.chip,p.mode===m.key&&s.active]}><Text style={p.mode===m.key?s.accent:s.white}>{m.label}</Text></Pressable>)}
      </ScrollView></Glass>
    </View>
  </View>;
}
const s=StyleSheet.create({
  scrim:{flex:1,justifyContent:'center',alignItems:'center',backgroundColor:'rgba(0,0,0,.62)',padding:8},
  sheet:{width:'100%',maxWidth:430,maxHeight:'96%'},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  title:{color:'#fff',fontSize:18,fontWeight:'700'},close:{padding:10},hint:{color:'#ccc',fontSize:12,lineHeight:17},
  white:{color:'#fff',fontSize:12},accent:{color:'#ffe16b',fontSize:12,fontWeight:'600'},row:{padding:12,borderRadius:16,backgroundColor:'rgba(255,255,255,.08)',gap:5},
  active:{backgroundColor:'rgba(255,225,107,.20)'},rearHeader:{position:'absolute',top:8,left:10,right:82,flexDirection:'row',justifyContent:'space-between'},
  brand:{fontSize:15,fontWeight:'700',color:'#fff'},rail:{position:'absolute',right:6,top:6,bottom:6,width:66,alignItems:'center',justifyContent:'space-evenly'},
  icon:{minHeight:38,minWidth:44,alignItems:'center',justifyContent:'center'},small:{fontSize:8,color:'#fff',marginTop:2},
  shutter:{width:54,height:54,borderRadius:27,borderColor:'#fff',borderWidth:2,alignItems:'center',justifyContent:'center'},inner:{width:44,height:44,borderRadius:22,backgroundColor:'#fff9ef'},red:{backgroundColor:'#ff3b30'},stop:{width:24,height:24,borderRadius:6},dim:{opacity:.4},
  bottom:{position:'absolute',left:8,right:82,bottom:8,gap:4},chips:{flexDirection:'row',gap:3,padding:3},chip:{minHeight:36,minWidth:40,paddingHorizontal:10,borderRadius:20,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(20,20,20,.45)'},
  toast:{color:'#fff',backgroundColor:'rgba(0,0,0,.7)',fontSize:11,padding:5,borderRadius:8},countdown:{color:'#fff',fontSize:28,textAlign:'center'},
});
