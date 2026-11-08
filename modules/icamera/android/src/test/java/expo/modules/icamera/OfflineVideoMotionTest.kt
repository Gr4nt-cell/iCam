package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*
import kotlin.random.Random

class OfflineVideoMotionTest {
  @Test fun rotationAndTranslationSurviveAnExposureChange() {
    val w=180;val h=320;val random=Random(73)
    val noise=IntArray(w*h){random.nextInt(30,210)}
    val source=IntArray(w*h){p->val x=p%w;val y=p/w;var sum=0;var n=0;for(j in -1..1)for(i in -1..1){sum+=noise[(y+j).coerceIn(0,h-1)*w+(x+i).coerceIn(0,w-1)];n++};sum/n}
    val angle=.018;val c=cos(angle);val s=sin(angle);val dx=6.0;val dy=-4.0
    val moved=IntArray(w*h){p->val x=p%w-w/2.0-dx;val y=p/w-h/2.0-dy;val xx=c*x+s*y+w/2;val yy=-s*x+c*y+h/2
      if(xx<0||yy<0||xx>=w-1||yy>=h-1)0 else {val ix=xx.toInt();val iy=yy.toInt();val fx=xx-ix;val fy=yy-iy
        ((source[iy*w+ix]*(1-fx)+source[iy*w+ix+1]*fx)*(1-fy)+(source[(iy+1)*w+ix]*(1-fx)+source[(iy+1)*w+ix+1]*fx)*fy+12).roundToInt().coerceIn(0,255)}}
    val m=OfflineVideoMotion.estimate(source,moved,w,h)
    assertTrue(m.reliable);assertEquals(dx,m.x,.6);assertEquals(dy,m.y,.6);assertEquals(angle,m.angle,.004)
  }
  @Test fun flatFramesAndSingleEdgesAreNotConfidentMotion() {
    for(p in listOf(IntArray(180*320){120},IntArray(180*320){if(it%180<90)30 else 200}))
      assertFalse(OfflineVideoMotion.estimate(p,p,180,320).reliable)
  }
  @Test fun symmetricSmoothingPreservesPanAndRemovesAlternatingShake() {
    val poses=(0..180).map{i->CameraPose(i*33333L,i*.18+if(i%2==0)2.0 else -2.0,0.0,if(i%2==0).006 else -.006)}
    val t=OfflineVideoPath.build(poses,180,320,1.08f,"cinematic",emptyList())
    val residual=(20..160).map{i->val p=t.at(poses[i].timeUs);abs(poses[i].x-p.x*180-i*.18)}.average()
    assertTrue("Residual shake=$residual",residual<.6)
    assertTrue(t.crop!!<=1.081f)
    for(p in poses){val s=t.at(p.timeUs);assertTrue(VideoProcessingGeometry.requiredCrop(s,180,320)<=t.crop!!)}
  }
  @Test fun futureFrameSmoothingDoesNotLeakAcrossSceneCuts() {
    val poses=(0..120).map{i->CameraPose(i*33333L,if(i<60)0.0 else 60.0,0.0,0.0,i==60)}
    val t=OfflineVideoPath.build(poses,180,320,1.08f,"cinematic",emptyList())
    for(i in poses.indices)assertEquals(0f,t.at(poses[i].timeUs).x,.0001f)
  }
  @Test fun constantCropCoversInterpolatedTransformsAndGravityRoll() {
    val poses=(0..60).map{i->CameraPose(i*33333L,sin(i*.5)*3,cos(i*.7)*2,0.0)}
    val rolls=poses.mapIndexed{i,p->RollSample(p.timeUs,(sin(i*.1)*.12).toFloat())}
    val t=OfflineVideoPath.build(poses,180,320,1.12f,"action",rolls)
    for(time in 0L..poses.last().timeUs step 8333){val p=t.at(time);assertTrue(VideoProcessingGeometry.requiredCrop(p,180,320)<=t.crop!!+.0001f)}
  }
  @Test fun visualYawDoesNotBecomeFalseRollWithoutAGravityTrace() {
    val poses=(0..30).map{i->CameraPose(i*33333L,i*1.5,0.0,sin(i*.8)*.04)}
    val t=OfflineVideoPath.build(poses,180,320,1.08f,"cinematic",emptyList())
    for(p in poses)assertEquals(0f,t.at(p.timeUs).roll,0f)
  }
  @Test fun normalGravityTraceRemovesTremorWithoutLockingDeliberateRoll() {
    val poses=(0..90).map{i->CameraPose(i*33333L,0.0,0.0,0.0)}
    val rolls=poses.mapIndexed{i,p->RollSample(p.timeUs,(i*.0003+if(i%2==0).008 else -.008).toFloat())}
    val t=OfflineVideoPath.build(poses,180,320,1.08f,"cinematic",rolls)
    val residual=(20..70).map{i->abs(rolls[i].radians-t.at(poses[i].timeUs).roll-i*.0003)}.average()
    assertTrue(residual<.001)
  }
  @Test fun trackingGapsDoNotResetTheCameraPath() {
    val times=(0..20).map{it*33333L}
    val motions=times.mapIndexed{i,_->FrameMotion(1.0,0.0,0.0,i !in 8..10 && i>0)}
    val poses=OfflineVideoPath.integrate(times,motions)
    assertEquals(20.0,poses.last().x,.00001)
    assertFalse(poses.any{it.cut})
  }

}
