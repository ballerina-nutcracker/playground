public function main() {
    // café, සිංහල, and an astral character: 🚀
    string greeting = "Hello 🚀 café";
    string result = decorate(
        greeting,
        "සිංහල"
    );
    int windows = windowsValue();
    _ = result;
    _ = windows;
}

function decorate(string left, string right) returns string {
    return left + " / " + right;
}
