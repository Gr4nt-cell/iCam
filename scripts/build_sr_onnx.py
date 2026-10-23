"""Writes Real-ESRGAN general x4v3 (SRVGGNetCompact) as ONNX with a hand-rolled protobuf encoder."""
import struct, sys, numpy as np

def varint(n):
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def key(f, wt): return varint((f << 3) | wt)
def f_int(f, v): return key(f, 0) + varint(v)
def f_bytes(f, b): return key(f, 2) + varint(len(b)) + b
def f_str(f, s): return f_bytes(f, s.encode())
def f_float(f, v): return key(f, 5) + struct.pack('<f', v)

def attr_int(name, v): return f_str(1, name) + f_int(3, v) + f_int(20, 2)
def attr_ints(name, vs): return f_str(1, name) + b''.join(f_int(8, v) for v in vs) + f_int(20, 7)
def attr_str(name, s): return f_str(1, name) + f_bytes(4, s.encode()) + f_int(20, 3)
def node(op, ins, outs, name, attrs=()):
    return (b''.join(f_str(1, i) for i in ins) + b''.join(f_str(2, o) for o in outs) +
            f_str(3, name) + f_str(4, op) + b''.join(f_bytes(5, a) for a in attrs))
def tensor(name, arr, dtype=1):
    return b''.join(f_int(1, d) for d in arr.shape) + f_int(2, dtype) + f_str(8, name) + f_bytes(9, arr.tobytes())
def vinfo(name, dims):
    shape = b''.join(f_bytes(1, f_int(1, d) if isinstance(d, int) else f_str(2, d)) for d in dims)
    tt = f_int(1, 1) + f_bytes(2, shape)
    return f_str(1, name) + f_bytes(2, f_bytes(1, tt))

def build(w, path, size=None):
    keys = list(w.keys())
    nodes, inits = [], []
    x = 'input'
    li = 0
    convs = [k[:-7] for k in keys if k.endswith('.weight') and w[k].ndim == 4]
    for ci, c in enumerate(convs):
        W, B = w[c + '.weight'], w[c + '.bias']
        inits += [tensor(c + '.weight', W.astype('<f4')), tensor(c + '.bias', B.astype('<f4'))]
        y = f'conv{ci}'
        nodes.append(node('Conv', [x, c + '.weight', c + '.bias'], [y], f'Conv_{ci}',
                          [attr_ints('kernel_shape', [3, 3]), attr_ints('pads', [1, 1, 1, 1]), attr_ints('strides', [1, 1])]))
        x = y
        idx = int(c.split('.')[1])
        pk = f'body.{idx + 1}.weight'
        if pk in w and w[pk].ndim == 1:
            slope = w[pk].astype('<f4').reshape(-1, 1, 1)
            inits.append(tensor(pk, slope))
            y = f'prelu{ci}'
            nodes.append(node('PRelu', [x, pk], [y], f'PRelu_{ci}'))
            x = y
    nodes.append(node('DepthToSpace', [x], ['up'], 'PixelShuffle', [attr_int('blocksize', 4), attr_str('mode', 'CRD')]))
    inits.append(tensor('scales', np.array([1, 1, 4, 4], '<f4')))
    nodes.append(node('Resize', ['input', '', 'scales'], ['base'], 'Base',
                      [attr_str('mode', 'nearest'), attr_str('nearest_mode', 'floor'), attr_str('coordinate_transformation_mode', 'asymmetric')]))
    nodes.append(node('Add', ['up', 'base'], ['output'], 'Add'))
    ins = [1, 3, size, size] if size else [1, 3, 'h', 'w']
    outs = [1, 3, size * 4, size * 4] if size else [1, 3, 'H', 'W']
    graph = (b''.join(f_bytes(1, n) for n in nodes) + f_str(2, 'srvgg') +
             b''.join(f_bytes(5, t) for t in inits) + f_bytes(11, vinfo('input', ins)) + f_bytes(12, vinfo('output', outs)))
    model = f_int(1, 8) + f_str(2, 'icam') + f_bytes(7, graph) + f_bytes(8, f_str(1, '') + f_int(2, 17))
    open(path, 'wb').write(model)

def ref(w, x):
    """numpy reference forward pass"""
    def conv(x, W, B):
        n, c, h, ww = x.shape
        p = np.pad(x, ((0, 0), (0, 0), (1, 1), (1, 1)))
        cols = np.stack([p[:, :, i:i + h, j:j + ww] for i in range(3) for j in range(3)], 2)  # n,c,9,h,w
        Wr = W.reshape(W.shape[0], c, 9)
        return np.einsum('ock,nckhw->nohw', Wr, cols) + B[None, :, None, None]
    keys = list(w.keys())
    convs = [k[:-7] for k in keys if k.endswith('.weight') and w[k].ndim == 4]
    out = x
    for c in convs:
        out = conv(out, w[c + '.weight'], w[c + '.bias'])
        idx = int(c.split('.')[1]); pk = f'body.{idx + 1}.weight'
        if pk in w and w[pk].ndim == 1:
            a = w[pk][None, :, None, None]; out = np.where(out > 0, out, out * a)
    n, C, h, ww = out.shape
    r = 4; oc = C // 16
    up = out.reshape(n, oc, r, r, h, ww).transpose(0, 1, 4, 2, 5, 3).reshape(n, oc, h * r, ww * r)
    base = x.repeat(4, 2).repeat(4, 3)
    return up + base

if __name__ == '__main__':
    w = dict(np.load(sys.argv[1]))
    build(w, sys.argv[2])
    build(w, sys.argv[2].replace('.onnx', '_208.onnx'), 208)
    import onnxruntime as ort
    x = np.random.rand(1, 3, 24, 24).astype('f4')
    y = ort.InferenceSession(sys.argv[2], providers=['CPUExecutionProvider']).run(None, {'input': x})[0]
    r = ref(w, x)
    print('dynamic', y.shape, float(np.abs(y - r).max()))
    xf = np.random.rand(1, 3, 208, 208).astype('f4')
    yf = ort.InferenceSession(sys.argv[2].replace('.onnx', '_208.onnx'), providers=['CPUExecutionProvider']).run(None, {'input': xf})[0]
    print('fixed', yf.shape)
    assert y.shape == (1, 3, 96, 96) and np.abs(y - r).max() < 1e-3
