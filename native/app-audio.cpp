// GameShareAudio.exe: records the sound of ONE app (or of everything except
// one app) using the Windows process-loopback API (Windows 10 2004+ / 11),
// and writes it to stdout as raw PCM: 48 kHz, 16-bit, stereo, interleaved.
//
//   GameShareAudio.exe window  <hwnd>  -> sound of the app that owns that window
//                                         (and its child processes, e.g. a browser's
//                                         audio process)
//   GameShareAudio.exe exclude <pid>   -> all sound EXCEPT that process tree
//                                         (used for whole-screen shares, pid = GameShare)
//
// It exits when stdin closes (so it never outlives GameShare) or on error.
// Errors go to stderr as one line starting with "ERROR".
//
// Build (from Linux): x86_64-w64-mingw32-g++ -O2 -static -municode -o GameShareAudio.exe app-audio.cpp -lole32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cwchar>

// ---- declarations missing from older SDK headers (audioclientactivationparams.h)
enum GS_ACTIVATION_TYPE { GS_ACTIVATION_TYPE_DEFAULT = 0, GS_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum GS_LOOPBACK_MODE { GS_INCLUDE_TARGET_PROCESS_TREE = 0, GS_EXCLUDE_TARGET_PROCESS_TREE = 1 };
struct GS_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; GS_LOOPBACK_MODE ProcessLoopbackMode; };
struct GS_ACTIVATION_PARAMS { GS_ACTIVATION_TYPE ActivationType; GS_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };
static const wchar_t *kProcessLoopbackDevice = L"VAD\\Process_Loopback";

// {94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90}
static const GUID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

typedef HRESULT(WINAPI *ActivateFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *,
                                    IActivateAudioInterfaceAsyncOperation **);

static void fail(const char *what, HRESULT hr) {
  fprintf(stderr, "ERROR %s (0x%08lx)\n", what, (unsigned long)hr);
  fflush(stderr);
  ExitProcess(1);
}

// Completion handler for ActivateAudioInterfaceAsync. Must be agile (free-threaded).
class Handler : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;

  STDMETHODIMP QueryInterface(REFIID riid, void **out) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
        riid == kIID_IAgileObject) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
  STDMETHODIMP_(ULONG) Release() override { return InterlockedDecrement(&refs); }  // lives on the stack

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT activateHr = E_FAIL;
    IUnknown *unk = nullptr;
    result = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(result)) result = activateHr;
    if (SUCCEEDED(result) && unk) result = unk->QueryInterface(__uuidof(IAudioClient), (void **)&client);
    if (unk) unk->Release();
    SetEvent(done);
    return S_OK;
  }

 private:
  LONG refs = 1;
};

// Exit as soon as GameShare closes our stdin (or dies).
static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  DWORD n;
  while (ReadFile(in, buf, sizeof buf, &n, nullptr) && n > 0) {}
  ExitProcess(0);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 3) {
    fprintf(stderr, "ERROR usage: GameShareAudio.exe window <hwnd> | exclude <pid>\n");
    return 2;
  }
  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);

  DWORD pid = 0;
  GS_LOOPBACK_MODE mode;
  if (wcscmp(argv[1], L"window") == 0) {
    HWND hwnd = (HWND)(ULONG_PTR)_wcstoui64(argv[2], nullptr, 10);
    if (!IsWindow(hwnd)) fail("window not found", E_INVALIDARG);
    GetWindowThreadProcessId(hwnd, &pid);
    mode = GS_INCLUDE_TARGET_PROCESS_TREE;
  } else if (wcscmp(argv[1], L"exclude") == 0) {
    pid = (DWORD)wcstoul(argv[2], nullptr, 10);
    mode = GS_EXCLUDE_TARGET_PROCESS_TREE;
  } else {
    fail("unknown mode", E_INVALIDARG);
    return 2;
  }
  if (!pid) fail("no process id", E_INVALIDARG);
  fprintf(stderr, "INFO pid %lu mode %s\n", (unsigned long)pid, mode == GS_INCLUDE_TARGET_PROCESS_TREE ? "include" : "exclude");
  if (mode == GS_INCLUDE_TARGET_PROCESS_TREE) {
    // Tell GameShare which program's sound this is (e.g. chrome.exe), so viewers can see it.
    wchar_t full[MAX_PATH] = L"";
    DWORD len = MAX_PATH;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h && QueryFullProcessImageNameW(h, 0, full, &len)) {
      const wchar_t *name = wcsrchr(full, L'\\');
      char utf8[MAX_PATH * 3] = "";
      WideCharToMultiByte(CP_UTF8, 0, name ? name + 1 : full, -1, utf8, sizeof utf8, nullptr, nullptr);
      fprintf(stderr, "INFO app %s\n", utf8);
    }
    if (h) CloseHandle(h);
  }
  fflush(stderr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("CoInitializeEx", hr);

  HMODULE mmdev = LoadLibraryW(L"Mmdevapi.dll");
  ActivateFn activate = mmdev ? (ActivateFn)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync") : nullptr;
  if (!activate) fail("ActivateAudioInterfaceAsync not available", E_NOTIMPL);

  GS_ACTIVATION_PARAMS params = {};
  params.ActivationType = GS_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = (BYTE *)&params;

  Handler handler;
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  hr = activate(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, &handler, &op);
  if (FAILED(hr)) fail("activate (needs Windows 10 version 2004 or newer)", hr);
  WaitForSingleObject(handler.done, INFINITE);
  if (op) op->Release();
  if (FAILED(handler.result) || !handler.client) fail("activate completed with error", handler.result);
  IAudioClient *client = handler.client;

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200000 /* 20 ms */, 0, &fmt, nullptr);
  if (FAILED(hr)) fail("IAudioClient::Initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) fail("SetEventHandle", hr);

  IAudioCaptureClient *capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void **)&capture);
  if (FAILED(hr)) fail("GetService", hr);

  hr = client->Start();
  if (FAILED(hr)) fail("Start", hr);
  fprintf(stderr, "READY\n");
  fflush(stderr);

  static BYTE zeros[48000 * 4];
  for (;;) {
    // The event only fires while the app is making sound; time out so we keep looping.
    WaitForSingleObject(ready, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(hr = capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) fail("GetBuffer", hr);
      UINT32 bytes = frames * fmt.nBlockAlign;
      const BYTE *src = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? zeros : data;
      if (bytes > sizeof zeros && src == zeros) bytes = sizeof zeros;
      if (bytes && fwrite(src, 1, bytes, stdout) != bytes) ExitProcess(0);  // GameShare went away
      capture->ReleaseBuffer(frames);
    }
    fflush(stdout);
    if (FAILED(hr)) fail("GetNextPacketSize", hr);
  }
}
