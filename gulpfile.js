let gulp = require('gulp'),
    path = require('path'),
    mocha = require('gulp-mocha'),
    gulpLoadPlugins = require('gulp-load-plugins'),
    runSequence = require('run-sequence'),
    plugins = gulpLoadPlugins({
        rename: {
            'gulp-angular-templatecache': 'templateCache'
        }
    });

gulp.task('default', function (done) {
    runSequence('env:dev', 'nodemon', done);
});

gulp.task('prod', function (done) {
    runSequence('env:prod', 'nodemon', done);
});

gulp.task('env:dev', function () {
    process.env.NODE_ENV = 'development';
});

gulp.task('env:prod', function () {
    process.env.NODE_ENV = 'production';
});

gulp.task('test', function (done) {
    console.log("starting test: " + process.pid)

    var testSuites = ['tests/test.*.js'];
    var error;
    console.dir(testSuites)

    gulp.src(testSuites)
        .pipe(mocha({
            reporter: 'spec',
            timeout: 10000,
            exit: true
        }))
        .on('error', function (err) {
            console.log("err")
            error = err;
            log.error(error.stack)
        })
        .on('end', function () {
            console.log("end")
            return done(error);
        });
});

gulp.task('nodemon', function () {
    let watchAssets =  ['app.js', '*.js', 'config/**/*.js', 'common_modules/**/*.js']

    return plugins.nodemon({
        script: 'app.js',
        nodeArgs: ["--inspect"],
        ext: 'js,html',
        verbose: true,
        watch: watchAssets
    });
});