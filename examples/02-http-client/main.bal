import ballerina/http;
import ballerina/io;

type Package record {
    string organization;
    string name;
    string version;
    int pullCount;
};

type SearchResult record {
    Package[] packages;
};

public function main() returns error? {
    string query = "aws";
    http:Client registry = check new ("https://api.central.ballerina.io/2.0/registry");
    http:Response res = check registry->get(string `/packages?q=${query}&limit=50`);
    SearchResult result = check (check res.getJsonPayload()).fromJsonWithType();

    string[] popular = from Package pkg in result.packages
        where pkg.pullCount > 100
        order by pkg.pullCount descending
        limit 5
        select string `${pkg.organization}/${pkg.name}:${pkg.version} (${pkg.pullCount} pulls)`;

    io:println(string `Top ${popular.length()} popular packages for query '${query}':`);
    foreach string pkg in popular {
        io:println(pkg);
    }
}
