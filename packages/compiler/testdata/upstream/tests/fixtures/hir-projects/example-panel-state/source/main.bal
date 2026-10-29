import ballerina/http;

service /reports on new http:Listener(8080) {
    resource function get daily() returns int { return buildReport(5); }
    resource function get weekly() returns int { return buildReport(35); }
}

function buildReport(int extraordinarilyLongButMeaningfulInputName) returns int {
    int calculatedReportTotal = extraordinarilyLongButMeaningfulInputName + 1;
    if calculatedReportTotal > 10 { return calculatedReportTotal; }
    return 10;
}
