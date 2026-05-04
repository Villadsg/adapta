import sys
import json
import subprocess
import tempfile
import os
import signal

data = json.loads(sys.stdin.read())
text = data.get("text", "").strip()
ref_audio = data.get("ref_audio", None)
speed = float(data.get("speed", 1.2))

if not text:
    print(json.dumps({"ok": False, "error": "empty text"}))
    sys.exit(0)

aplay_proc = None

def handle_term(signum, frame):
    if aplay_proc is not None:
        aplay_proc.kill()
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_term)
signal.signal(signal.SIGINT, handle_term)

try:
    import torch
    from omnivoice import OmniVoice
    import soundfile as sf

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device)

    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig
    num_step = int(data.get("num_step", 16))
    generation_config = OmniVoiceGenerationConfig(num_step=num_step)
    kwargs = {"text": text, "language": "English", "speed": speed, "generation_config": generation_config}
    if ref_audio and os.path.exists(ref_audio):
        kwargs["ref_audio"] = ref_audio
        ref_text_path = os.path.splitext(ref_audio)[0] + ".txt"
        if os.path.exists(ref_text_path):
            with open(ref_text_path) as f:
                kwargs["ref_text"] = f.read().strip()

    audio = model.generate(**kwargs)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = f.name

    output_file = data.get("output_file", None)
    if output_file:
        if output_file.lower().endswith(".mp3"):
            from pydub import AudioSegment
            sf.write(tmp_path, audio[0], 24000)
            AudioSegment.from_wav(tmp_path).export(output_file, format="mp3")
            os.unlink(tmp_path)
        elif output_file.lower().endswith(".m4a"):
            from pydub import AudioSegment
            sf.write(tmp_path, audio[0], 24000)
            AudioSegment.from_wav(tmp_path).export(output_file, format="mp4")
            os.unlink(tmp_path)
        else:
            sf.write(output_file, audio[0], 24000)
    else:
        sf.write(tmp_path, audio[0], 24000)
        aplay_proc = subprocess.Popen(["aplay", "-q", tmp_path])
        aplay_proc.wait()
        aplay_proc = None
        os.unlink(tmp_path)

    print(json.dumps({"ok": True}))

except ImportError:
    aplay_proc = subprocess.Popen(["espeak-ng", "-v", "en", "-s", "160", text])
    aplay_proc.wait()
    aplay_proc = None
    print(json.dumps({"ok": True, "fallback": "espeak-ng"}))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
