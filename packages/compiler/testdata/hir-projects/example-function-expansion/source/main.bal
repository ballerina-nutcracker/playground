public function main() {
    int first = shared(2);
    int second = shared(3);
    int recursive = countdown(first);
    int mutual = evenStep(second);
    _ = recursive;
    _ = mutual;
}
