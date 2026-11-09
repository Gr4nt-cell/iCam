package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class RecordingStartGateTest {
  @Test fun stopBeforeTheSoundFinishesPreventsRecording() {
    val gate=RecordingStartGate();val token=gate.begin()
    assertTrue(gate.cancel());assertFalse(gate.consume(token));assertFalse(gate.pending)
  }
  @Test fun oldCallbackCannotConsumeANewerStart() {
    val gate=RecordingStartGate();val old=gate.begin();gate.cancel();val current=gate.begin()
    assertFalse(gate.consume(old));assertTrue(gate.pending)
    assertTrue(gate.consume(current));assertFalse(gate.consume(current))
  }
  @Test fun cancellingAfterStartDoesNotReportAPendingStart() {
    val gate=RecordingStartGate();val token=gate.begin();assertTrue(gate.consume(token))
    assertFalse(gate.cancel())
  }
}
