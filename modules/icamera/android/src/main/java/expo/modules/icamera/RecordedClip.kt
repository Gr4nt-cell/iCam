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

  /** Encoded video size as stored in the file (the rotation tag is not applied), or null. */
  fun dimensions(file: File): Pair<Int, Int>? {
    if(!file.isFile || file.length()==0L)return null
    val extractor=MediaExtractor()
    return try {
      extractor.setDataSource(file.absolutePath)
      val video=(0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString("mime")?.startsWith("video/")==true
      } ?: return null
      val format=extractor.getTrackFormat(video)
      if(!format.containsKey("width") || !format.containsKey("height")) return null
      format.getInteger("width") to format.getInteger("height")
    }catch(_:Exception){null}finally{extractor.release()}
  }
}
