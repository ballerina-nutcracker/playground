import ballerina/http;
import ballerina/log;

type Album record {|
    string title;
    string artist;
|};

Album[] albums = [
    {title: "Blue Train", artist: "John Coltrane"},
    {title: "Jeru", artist: "Gerry Mulligan"}
];

service / on new http:Listener(9090) {

    resource function get albums() returns http:Response {
        http:Response response = new;
        response.setJsonPayload(albums);
        return response;
    }

    resource function post albums(http:Request req) returns http:Response|error {
        Album album = check (check req.getJsonPayload()).fromJsonWithType();
        albums.push(album);

        http:Response response = new;
        response.statusCode = 201;
        response.setJsonPayload(albums);

        log:printInfo(string `[INFO] Album added successfully: ${album.title} by ${album.artist}`);
        return response;
    }

    resource function get albums/[string title]() returns http:Response {
        Album[] selectedAlbums = from Album album in albums
            where album.title == title
            limit 1
            select album;
        http:Response res = new;
        if selectedAlbums.length() == 0 {
            res.statusCode = 404;
            res.setTextPayload(string `album not found with title - ${title}`);
            log:printError(string `[ERROR] Album not found with title - ${title}`);
        } else {
            res.setJsonPayload(selectedAlbums[0]);
        }
        return res;
    }
}

