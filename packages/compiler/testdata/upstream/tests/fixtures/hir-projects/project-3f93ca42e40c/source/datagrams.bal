import ballerina/udp;

service on new udp:Listener(9090) {
    remote function onBytes(byte[] data, udp:Caller caller) returns byte[] {
        _ = caller;
        return data;
    }
}
