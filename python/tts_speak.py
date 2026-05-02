import sys
import json
import subprocess
import tempfile
import os

data = json.loads(sys.stdin.read())
text = data.get("text", "").strip()
ref_audio = data.get("ref_audio", None)
speed = data.get("speed", 1.2)

if not text:
    print(json.dumps({"ok": False, "error": "empty text"}))
    sys.exit(0)

try:
    import torch
    from omnivoice import OmniVoice
    import soundfile as sf

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device)

    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig
    generation_config = OmniVoiceGenerationConfig(num_step=16)
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

    sf.write(tmp_path, audio[0], 24000)
    subprocess.run(["aplay", "-q", tmp_path], check=False)
    os.unlink(tmp_path)

    print(json.dumps({"ok": True}))

except ImportError:
    subprocess.run(["espeak-ng", "-v", "en", "-s", "160", text], check=False)
    print(json.dumps({"ok": True, "fallback": "espeak-ng"}))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
