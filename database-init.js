const MongoClient = require('mongodb').MongoClient;
const mongoURL = 'mongodb://127.0.0.1:27017';
const dbName = 'A1';

//connect to MongoDB
MongoClient.connect(mongoURL, function (error, client) {
    if (error) throw error;
    let db = client.db(dbName);

    db.listCollections().toArray(function (_, result) {
        //initial connection, no collections exist yet so we create pages collection 
        if (result.length == 0) {
            db.createCollection("pages", function (error, _) {
                if (error) throw error;
                console.log("Created collection: pages");
                client.close();
            });
            return;
        }

        //pages collection already exists, so we drop all collections
        let collectionsDropped = 0;
        let collectionsCount = result.length;
        result.forEach(collection => {
            db.collection(collection.name).drop(function (error, _) {
                if (error) throw error;
                console.log(`Dropped collection: ${collection.name}`);
                collectionsDropped++;

                //all collections dropped, create pages collection again
                if (collectionsDropped == collectionsCount) {
                    db.createCollection("pages", function (error, _) {
                        if (error) throw error;
                        console.log("Created collection: pages");
                        client.close();
                    });
                }
            });
        });
    });
});