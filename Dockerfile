# Docker image to build Neon Relay for Linux and Windows (32 bit, 64 bit).
#
# Neon Relay is a standalone derivative of the upstream DDNet project; the dependency
# list below is the one upstream needs (see docs/BUILDING.md and license.txt).
#
# Usage:
# 1. Build image
# docker build -t neonrelay-builder - < Dockerfile
# 2. Run the Neon Relay build script
# docker run -it -v PATH_TO_NEON_RELAY:/neonrelay:ro -v PATH_TO_OUTPUT_DIRECTORY:/build \
#   neonrelay-builder ./build-all.sh
FROM debian:12

RUN apt-get update && apt-get install -y gcc-mingw-w64-x86-64-posix \
        g++-mingw-w64-x86-64-posix \
        gcc-mingw-w64-i686-posix \
        g++-mingw-w64-i686-posix \
        wget \
        git \
        ca-certificates \
        build-essential \
        python3 \
        libcurl4-openssl-dev \
        libfreetype6-dev \
        libglew-dev \
        libogg-dev \
        libopus-dev \
        libpng-dev \
        libwavpack-dev \
        libopusfile-dev \
        libsdl2-dev \
        cmake \
        glslang-tools \
        libavcodec-extra \
        libavdevice-dev \
        libavfilter-dev \
        libavformat-dev \
        libavutil-dev \
        libcurl4-openssl-dev \
        libnotify-dev \
        libsqlite3-dev \
        libssl-dev \
        libvulkan-dev \
        libx264-dev \
        spirv-tools \
        curl

RUN curl https://sh.rustup.rs -sSf | \
    sh -s -- --default-toolchain stable -y

RUN ~/.cargo/bin/rustup toolchain install stable
RUN ~/.cargo/bin/rustup target add i686-pc-windows-gnu
RUN ~/.cargo/bin/rustup target add x86_64-pc-windows-gnu

# NOTE: the source tree must contain the prebuilt dependency libraries. Either mount a
# checkout that includes them, or initialise the `ddnet-libs` submodule recorded in
# .gitmodules before building (see UPSTREAM_BASE.md).
RUN printf '#!/bin/bash\n \
        export PATH=$PATH:$HOME/.cargo/bin\n \
        set -x\n \
        mkdir /build\n \
        mkdir /build/linux\n \
        cd /build/linux\n \
        pwd\n \
        cmake /neonrelay && make -j$(nproc) \n \
        mkdir /build/win64\n \
        cd /build/win64\n \
        pwd\n \
        cmake -DCMAKE_TOOLCHAIN_FILE=/neonrelay/cmake/toolchains/mingw64.toolchain /neonrelay && make -j$(nproc) \n \
        mkdir /build/win32\n \
        cd /build/win32\n \
        pwd\n \
        cmake -DCMAKE_TOOLCHAIN_FILE=/neonrelay/cmake/toolchains/mingw32.toolchain /neonrelay && make -j$(nproc) \n' \
        > build-all.sh
RUN chmod +x build-all.sh
RUN mkdir /build
