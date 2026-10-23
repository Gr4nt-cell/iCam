"""
Exports Real-ESRGAN "realesr-general-x4v3" (SRVGGNetCompact, BSD-3-Clause, xinntao/Real-ESRGAN)
to ONNX for on-device AI zoom. Run in CI: python scripts/export_sr_model.py <pth> <out.onnx>
"""
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F


class SRVGGNetCompact(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


def main(pth, out):
    model = SRVGGNetCompact()
    state = torch.load(pth, map_location="cpu")
    state = state.get("params_ema", state.get("params", state))
    model.load_state_dict(state, strict=True)
    model.eval()
    x = torch.rand(1, 3, 64, 64)
    torch.onnx.export(
        model, x, out, opset_version=17, input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "H", 3: "W"}}, dynamo=False,
    )
    # sanity check with ONNX Runtime against PyTorch
    import numpy as np
    import onnxruntime as ort
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    y = sess.run(None, {"input": x.numpy()})[0]
    ref = model(x).detach().numpy()
    err = float(np.abs(y - ref).max())
    print(f"exported {out}: output {y.shape}, max abs diff vs torch {err:.2e}")
    assert y.shape == (1, 3, 256, 256) and err < 1e-3

    # Fixed-shape copy (208×208 tiles) for the phone's accelerator (NNAPI needs static shapes)
    fixed = out.replace(".onnx", "_208.onnx")
    xf = torch.rand(1, 3, 208, 208)
    torch.onnx.export(model, xf, fixed, opset_version=17, input_names=["input"], output_names=["output"], dynamo=False)
    yf = ort.InferenceSession(fixed, providers=["CPUExecutionProvider"]).run(None, {"input": xf.numpy()})[0]
    errf = float(np.abs(yf - model(xf).detach().numpy()).max())
    print(f"exported {fixed}: output {yf.shape}, max abs diff vs torch {errf:.2e}")
    assert yf.shape == (1, 3, 832, 832) and errf < 1e-3


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
