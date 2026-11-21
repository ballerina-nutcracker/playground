import ballerina/io;

public function main() returns error? {
    stream<string, io:Error?> initialLines = check io:fileReadLinesAsStream("input-lines.txt");
    check io:fileWriteLinesFromStream("nested/lines.txt", initialLines);

    stream<string, io:Error?> appendedLines = check io:fileReadLinesAsStream("append-lines.txt");
    check io:fileWriteLinesFromStream("nested/lines.txt", appendedLines, io:APPEND);

    string lines = check io:fileReadString("nested/lines.txt");
    io:println(lines == "Alpha\nBeta\nGamma");

    stream<io:Block, io:Error?> initialBlocks = check io:fileReadBlocksAsStream("input-blocks.bin", 2);
    check io:fileWriteBlocksFromStream("nested/blocks.bin", initialBlocks);

    stream<io:Block, io:Error?> appendedBlocks = check io:fileReadBlocksAsStream("append-blocks.bin", 2);
    check io:fileWriteBlocksFromStream("nested/blocks.bin", appendedBlocks, io:APPEND);

    byte[] content = check io:fileReadBytes("nested/blocks.bin");
    io:println(content == [65, 66, 67, 68]);
}
