package expo.modules.icamera

import android.media.MediaExtractor
import java.io.File

/** A nonempty MP4 header is not proof that the recorder wrote a video frame. */
internal object RecordedClip {
  fun hasVideoSample(file: File): Boolean {
    if(!file.isFile || file.length()==0L)return false
    val extractor=MediaExtractor()
    return try {
      extractor.setDataSource(file.absolutePath)
      val video=(0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString("mime")?.startsWith("video/")==true
      } ?: return false
      extractor.selectTrack(video)
      extractor.sampleTime>=0
    }catch(_:Exception){false}finally{extractor.release()}
  }
}
