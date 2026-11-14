// GameShareKeys.exe: tells GameShare when the push-to-talk key is held, even
// while a game has focus. It only asks Windows whether the keys given on the
// command line are down right now (it never sees what you type, and the game
// still gets the key).
//
//   GameShareKeys.exe <vk> [<vk> ...]   -> virtual-key codes (decimal), e.g. 17 32 = Ctrl+Space
//
// Writes "D\n" to stdout when all of them are down and "U\n" when they no
// longer are. It exits when stdin closes (so it never outlives GameShare).
//
// Build (from Linux): x86_64-w64-mingw32-g++ -O2 -static -municode -o GameShareKeys.exe keys.cpp
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>

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
  int vks[4];
  int count = 0;
  for (int i = 1; i < argc && count < 4; i++) {
    int v = _wtoi(argv[i]);
    if (v > 0 && v < 256) vks[count++] = v;
  }
  if (!count) {
    fprintf(stderr, "ERROR usage: GameShareKeys.exe <vk> [<vk> ...]\n");
    return 2;
  }
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  fprintf(stderr, "READY\n");
  fflush(stderr);

  bool down = false;
  for (;;) {
    bool now = true;
    for (int i = 0; i < count; i++) {
      if (!(GetAsyncKeyState(vks[i]) & 0x8000)) { now = false; break; }
    }
    if (now != down) {
      down = now;
      DWORD written;
      if (!WriteFile(out, down ? "D\n" : "U\n", 2, &written, nullptr)) return 0; // GameShare is gone
    }
    Sleep(8);
  }
}
