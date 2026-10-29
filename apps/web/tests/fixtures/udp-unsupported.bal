import ballerina/udp;

public function main() returns error? {
    udp:ConnectClient _ = check new ("localhost", 9000);
}
